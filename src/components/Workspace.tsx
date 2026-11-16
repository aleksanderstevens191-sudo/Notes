import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, uid } from '../store';
import { useUI, setUI, ui, anchorKey } from '../ui';
import type { Stroke, WsItem, Workspace as WS } from '../types';
import { strokeOutline, strokeHit, eraseFromStroke, simplify, strokeInPoly, isConnectorLike, pointInPoly, bbox } from '../ink';
import { liveStart, liveAdd, liveEnd } from '../liveInk';
import { pointerDraws, notePointer, setGestureLock, coalesced, pressureOf } from '../input';
import { edit, anchorAtPoint, docPosAt, addLink, goToSource, linksFor, goToAnchor, docLabel, createNote, data } from '../actions';
import { lastInStack } from './DocView';
import { linkAtPoint } from './LinkOverlay';

export function Workspace() {
  const ws = useApp((s) => s.project!.data.workspaces.find((w) => w.id === s.project!.data.activeWs) ?? s.project!.data.workspaces[0]);
  const links = useApp((s) => s.project!.data.links);
  const tool = useApp((s) => s.tool);
  const settings = useApp((s) => s.settings);
  const penSeen = useApp((s) => s.penSeen);
  const wsSel = useUI((s) => s.wsSel);
  const wsInkSel = useUI((s) => s.wsInkSel);
  const editing = useUI((s) => s.editingItem);
  const focusReq = useUI((s) => s.wsFocusReq);
  const paneRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(ws.view);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [drag, setDrag] = useState<{ ids: string[]; inkIds: string[]; dx: number; dy: number } | null>(null);
  const [resize, setResize] = useState<{ id: string; w: number; h?: number } | null>(null);
  const [marquee, setMarquee] = useState<[number, number, number, number] | null>(null);
  const [dockHint, setDockHint] = useState<string | null>(null);

  // sync view when workspace switches
  useEffect(() => setView(ws.view), [ws.id]);
  const commitView = useRef<ReturnType<typeof setTimeout>>();
  const updateView = (v: { x: number; y: number; zoom: number }) => {
    setView(v);
    viewRef.current = v;
    clearTimeout(commitView.current);
    commitView.current = setTimeout(() => {
      useApp.getState().editSilent((d) => {
        const w = d.workspaces.find((x) => x.id === ws.id);
        if (w) w.view = v;
      });
    }, 400);
  };

  // focus request (pan to item)
  useEffect(() => {
    if (!focusReq) return;
    const it = ws.items.find((i) => i.id === focusReq.id);
    const el = paneRef.current;
    if (!it || !el) return;
    const pos = itemPos(ws, it);
    const v = viewRef.current;
    updateView({ ...v, x: el.clientWidth / 2 - (pos.x + it.w / 2) * v.zoom, y: el.clientHeight / 3 - pos.y * v.zoom });
  }, [focusReq]);

  const toWorld = (cx: number, cy: number) => {
    const r = paneRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (cx - r.left - v.x) / v.zoom, y: (cy - r.top - v.y) / v.zoom };
  };

  const fitAll = () => {
    const el = paneRef.current;
    if (!el) return;
    const boxes: [number, number, number, number][] = [];
    for (const it of ws.items) {
      const n = document.querySelector(`[data-item-id="${it.id}"]`) as HTMLElement | null;
      const p = itemPos(ws, it);
      boxes.push([p.x, p.y, it.w, n ? n.offsetHeight : it.h ?? 100]);
    }
    for (const s of ws.ink) boxes.push(bbox(s.points));
    if (!boxes.length) return updateView({ x: 0, y: 0, zoom: 1 });
    const x0 = Math.min(...boxes.map((b) => b[0]));
    const y0 = Math.min(...boxes.map((b) => b[1]));
    const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
    const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
    const z = Math.max(0.15, Math.min(2, Math.min((el.clientWidth - 60) / (x1 - x0 || 1), (el.clientHeight - 60) / (y1 - y0 || 1))));
    updateView({ zoom: z, x: (el.clientWidth - (x1 - x0) * z) / 2 - x0 * z, y: (el.clientHeight - (y1 - y0) * z) / 2 - y0 * z });
  };
  useEffect(() => {
    const fn = (e: Event) => {
      const a = (e as CustomEvent).detail;
      if (a === 'fit') fitAll();
      if (a === 'zoomIn' || a === 'zoomOut') {
        const el = paneRef.current!;
        const v = viewRef.current;
        const nz = Math.max(0.1, Math.min(4, v.zoom * (a === 'zoomIn' ? 1.25 : 0.8)));
        const cx = el.clientWidth / 2,
          cy = el.clientHeight / 2;
        updateView({ zoom: nz, x: cx - ((cx - v.x) / v.zoom) * nz, y: cy - ((cy - v.y) / v.zoom) * nz });
      }
    };
    window.addEventListener('ws-action', fn);
    return () => window.removeEventListener('ws-action', fn);
  });

  // ------- gestures -------
  const g = useRef<any>({ mode: 'idle' });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastTap = useRef({ t: 0, id: '' });

  const onPointerDown = (e: React.PointerEvent) => {
    notePointer(e);
    const target = e.target as HTMLElement;
    if (target.closest('.no-ws-gesture') || target.closest('[contenteditable="true"]')) return;
    if (e.isPrimary) pointers.current.clear();
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch' && pointers.current.size === 2) {
      if (g.current.mode === 'ink' || g.current.mode === 'lasso' || g.current.mode === 'erase') liveEnd();
      const [a, b] = Array.from(pointers.current.values());
      g.current = { mode: 'pinch', a0: a, b0: b, v0: { ...viewRef.current }, d0: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
      setDrag(null);
      return;
    }
    if (pointers.current.size > 2) return;
    if (e.pointerType === 'mouse' && e.button === 1) {
      g.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, v0: { ...viewRef.current } };
      return;
    }
    const draws = pointerDraws(e.nativeEvent);
    const itemEl = target.closest('[data-item-id]') as HTMLElement | null;
    const resizeEl = target.closest('[data-resize]') as HTMLElement | null;
    const w = toWorld(e.clientX, e.clientY);
    setGestureLock(true);

    if ((tool === 'pen' || tool === 'highlighter') && draws) {
      const color = tool === 'pen' ? settings.penColor : settings.hlInkColor;
      const wd = tool === 'pen' ? settings.penWidth : settings.hlInkWidth;
      liveStart(tool, color, wd * viewRef.current.zoom);
      liveAdd(e.clientX, e.clientY, pressureOf(e.nativeEvent));
      g.current = { mode: 'ink', color, w: wd, startAnchor: anchorAtPoint(e.clientX, e.clientY) };
      return;
    }
    if (tool === 'eraser' && draws) {
      g.current = { mode: 'erase', key: 'wserase-' + uid() };
      liveStart('eraser', '#999', 18);
      eraseAt(e.clientX, e.clientY);
      return;
    }
    if (tool === 'lasso' && draws) {
      // drag existing selection
      if ((wsSel.length || wsInkSel.length) && (itemEl && wsSel.includes(itemEl.dataset.itemId!) || inSelBox(w.x, w.y))) {
        g.current = { mode: 'drag', sx: e.clientX, sy: e.clientY, ids: wsSel, inkIds: wsInkSel, moved: false };
        return;
      }
      liveStart('lasso', '#5b6bff', 1);
      liveAdd(e.clientX, e.clientY, 0.5);
      g.current = { mode: 'lasso' };
      return;
    }

    if (resizeEl) {
      const id = resizeEl.dataset.resize!;
      const it = ws.items.find((i) => i.id === id)!;
      g.current = { mode: 'resize', id, sx: e.clientX, sy: e.clientY, w0: it.w, h0: it.h ?? (itemEl?.offsetHeight ?? 100) / 1 };
      return;
    }
    if (itemEl) {
      const id = itemEl.dataset.itemId!;
      const ids = wsSel.includes(id) ? wsSel : [id];
      g.current = { mode: 'press', id, ids, sx: e.clientX, sy: e.clientY, moved: false, t: Date.now(), touch: e.pointerType === 'touch' };
      return;
    }
    // empty space
    if (e.pointerType === 'pen' && tool === 'select') {
      g.current = { mode: 'marquee', sx: w.x, sy: w.y, cx: e.clientX, cy: e.clientY };
      return;
    }
    g.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, v0: { ...viewRef.current }, moved: false };
  };

  const inSelBox = (x: number, y: number) => {
    const els = wsSel.map((id) => document.querySelector(`[data-item-id="${id}"]`) as HTMLElement | null).filter(Boolean) as HTMLElement[];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const a = toWorld(r.left, r.top),
        b = toWorld(r.right, r.bottom);
      if (x >= a.x && x <= b.x && y >= a.y && y <= b.y) return true;
    }
    for (const id of wsInkSel) {
      const s = ws.ink.find((k) => k.id === id);
      if (!s) continue;
      const bb = bbox(s.points);
      if (x >= bb[0] - 10 && x <= bb[0] + bb[2] + 10 && y >= bb[1] - 10 && y <= bb[1] + bb[3] + 10) return true;
    }
    return false;
  };

  const eraseAt = (cx: number, cy: number) => {
    liveAdd(cx, cy, 0.5);
    const w = toWorld(cx, cy);
    const r = 9 / viewRef.current.zoom;
    const hits = ws.ink.filter((s) => strokeHit(s, w.x, w.y, r));
    // links under the eraser
    const lk = linkAtPoint(cx, cy, 8);
    const linkEls = lk ? [lk] : [];
    if (!hits.length && !linkEls.length) return;
    edit((d) => {
      const wsd = d.workspaces.find((x) => x.id === ws.id)!;
      if (settings.eraserMode === 'point') {
        for (const s of hits) {
          const pieces = eraseFromStroke(s, w.x, w.y, r);
          if (!pieces) continue;
          const i = wsd.ink.findIndex((x) => x.id === s.id);
          if (i >= 0) wsd.ink.splice(i, 1, ...pieces.map((p) => ({ ...s, id: uid(), points: p })));
        }
      } else {
        const ids = new Set(hits.map((h) => h.id));
        wsd.ink = wsd.ink.filter((s) => !ids.has(s.id));
      }
      d.links = d.links.filter((l) => !linkEls.includes(l.id));
    }, { coalesce: g.current.key });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = g.current;
    const z = viewRef.current.zoom;
    switch (st.mode) {
      case 'pinch': {
        const ps = Array.from(pointers.current.values());
        if (ps.length < 2) return;
        const [a, b] = ps;
        const r = paneRef.current!.getBoundingClientRect();
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const nz = Math.max(0.1, Math.min(4, st.v0.zoom * (d / st.d0)));
        const m0 = { x: (st.a0.x + st.b0.x) / 2 - r.left, y: (st.a0.y + st.b0.y) / 2 - r.top };
        const m1 = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
        const wx = (m0.x - st.v0.x) / st.v0.zoom,
          wy = (m0.y - st.v0.y) / st.v0.zoom;
        updateView({ zoom: nz, x: m1.x - wx * nz, y: m1.y - wy * nz });
        return;
      }
      case 'pan': {
        if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) > 3) st.moved = true;
        updateView({ ...st.v0, x: st.v0.x + e.clientX - st.sx, y: st.v0.y + e.clientY - st.sy });
        return;
      }
      case 'ink':
        for (const ce of coalesced(e.nativeEvent)) liveAdd(ce.clientX, ce.clientY, pressureOf(ce));
        return;
      case 'erase':
        for (const ce of coalesced(e.nativeEvent)) eraseAt(ce.clientX, ce.clientY);
        return;
      case 'lasso':
        liveAdd(e.clientX, e.clientY, 0.5);
        return;
      case 'marquee': {
        const w = toWorld(e.clientX, e.clientY);
        setMarquee([Math.min(st.sx, w.x), Math.min(st.sy, w.y), Math.abs(w.x - st.sx), Math.abs(w.y - st.sy)]);
        return;
      }
      case 'press': {
        const dist = Math.hypot(e.clientX - st.sx, e.clientY - st.sy);
        if (dist < 5) return;
        if (st.touch && Date.now() - st.t < 120 && !wsSel.includes(st.id)) {
          // quick finger flick on a card = pan the workspace
          g.current = { mode: 'pan', sx: st.sx, sy: st.sy, v0: { ...viewRef.current }, moved: true };
          return;
        }
        // dragging a docked card out of its stack: undock
        const it = ws.items.find((i) => i.id === st.id)!;
        let ids: string[] = st.ids;
        if (it.dockedTo && st.ids.length === 1) {
          const pos = itemPos(ws, it);
          edit((d) => {
            const wsd = d.workspaces.find((x) => x.id === ws.id)!;
            const m = wsd.items.find((x) => x.id === st.id)!;
            const child = wsd.items.find((x) => x.dockedTo === st.id);
            if (child) child.dockedTo = m.dockedTo; // keep the stack intact below
            m.dockedTo = undefined;
            m.x = pos.x;
            m.y = pos.y;
          });
          ids = [st.id];
        }
        // include stacked children of moved heads
        const all = new Set(ids);
        let grew = true;
        while (grew) {
          grew = false;
          for (const x of data().workspaces.find((w) => w.id === ws.id)!.items) if (x.dockedTo && all.has(x.dockedTo) && !all.has(x.id)) {
            all.add(x.id);
            grew = true;
          }
        }
        g.current = { mode: 'drag', sx: st.sx, sy: st.sy, ids: Array.from(all), inkIds: wsSel.includes(st.id) ? wsInkSel : [], moved: true, head: st.id };
        if (!wsSel.includes(st.id)) setUI({ wsSel: [st.id], wsInkSel: [] });
        setUI({ popover: null });
      }
      // falls through
      case 'drag': {
        const s2 = g.current;
        s2.moved = true;
        setDrag({ ids: s2.ids, inkIds: s2.inkIds, dx: (e.clientX - s2.sx) / z, dy: (e.clientY - s2.sy) / z });
        // dock hint
        if (settings.snapExcerpts && s2.head) setDockHint(findDock(e.clientX, e.clientY, s2.ids));
        // dragging a card out onto the document = link card to that spot
        return;
      }
      case 'resize': {
        const dw = (e.clientX - st.sx) / z;
        const dh = (e.clientY - st.sy) / z;
        const it = ws.items.find((i) => i.id === st.id)!;
        setResize({ id: st.id, w: Math.max(120, st.w0 + dw), h: it.type !== 'excerpt' ? Math.max(60, st.h0 + dh) : undefined });
        return;
      }
    }
  };

  const findDock = (cx: number, cy: number, moving: string[]): string | null => {
    const els = document.elementsFromPoint(cx, cy);
    for (const el of els) {
      const id = (el as HTMLElement).dataset?.itemId;
      if (id && !moving.includes(id)) {
        const r = el.getBoundingClientRect();
        if (cy > r.top + r.height * 0.55) return lastInStack(id);
      }
    }
    return null;
  };

  const onPointerUp = (e: React.PointerEvent, cancelled = false) => {
    pointers.current.delete(e.pointerId);
    const st = g.current;
    if (st.mode === 'pinch') {
      if (pointers.current.size === 0) {
        g.current = { mode: 'idle' };
        setGestureLock(false);
      }
      return;
    }
    g.current = { mode: 'idle' };
    setGestureLock(false);
    switch (st.mode) {
      case 'pan':
        if (!st.moved) {
          // tap on empty space
          const lf = ui().linkFrom;
          if (lf) {
            setUI({ linkFrom: null });
            return;
          }
          const lk = linkAtPoint(e.clientX, e.clientY);
          if (lk) {
            setUI({ popover: { kind: 'link', id: lk, x: e.clientX, y: e.clientY } });
            return;
          }
          setUI({ wsSel: [], wsInkSel: [], popover: null, editingItem: null });
          // double tap on empty space creates a note (like a text box)
          const now = Date.now();
          if (now - lastTap.current.t < 320 && lastTap.current.id === '__empty') {
            const w = toWorld(e.clientX, e.clientY);
            createNote({ x: w.x - 20, y: w.y - 16 });
          }
          lastTap.current = { t: now, id: '__empty' };
        }
        return;
      case 'ink': {
        const pts = liveEnd();
        if (cancelled || !pts.length) return;
        if (settings.linkByInk && isConnectorLike(pts)) {
          const last = pts[pts.length - 1];
          let b = anchorAtPoint(last[0], last[1]);
          const a = st.startAnchor;
          if (a && !b) b = docPosAt(last[0], last[1]); // card -> spot in the document
          if (a && b && anchorKey(a) !== anchorKey(b)) {
            addLink(a, b, st.color);
            useApp.getState().showToast('Linked');
            return;
          }
        }
        const r = paneRef.current!.getBoundingClientRect();
        const v = viewRef.current;
        const wp = simplify(pts.map((p) => [(p[0] - r.left - v.x) / v.zoom, (p[1] - r.top - v.y) / v.zoom, p[2]] as [number, number, number]), 0.5 / v.zoom);
        const stroke: Stroke = { id: uid(), points: wp, color: st.color, width: st.w, kind: tool === 'highlighter' ? 'highlighter' : 'pen' };
        edit((d) => {
          d.workspaces.find((x) => x.id === ws.id)!.ink.push(stroke);
        });
        return;
      }
      case 'erase':
        liveEnd();
        return;
      case 'lasso': {
        const pts = liveEnd();
        if (pts.length < 3) return;
        const poly = pts.map((p) => {
          const w = toWorld(p[0], p[1]);
          return [w.x, w.y] as [number, number];
        });
        const items = ws.items.filter((it) => {
          const el = document.querySelector(`[data-item-id="${it.id}"]`) as HTMLElement | null;
          const p = itemPos(ws, it);
          const h = el ? el.offsetHeight : it.h ?? 80;
          return pointInPoly(p.x + it.w / 2, p.y + h / 2, poly);
        });
        const ink = ws.ink.filter((s) => strokeInPoly(s, poly));
        setUI({ wsSel: items.map((i) => i.id), wsInkSel: ink.map((s) => s.id) });
        if (items.length || ink.length) {
          const xs = pts.map((p) => p[0]);
          const ys = pts.map((p) => p[1]);
          setUI({ popover: { kind: 'item', ids: items.map((i) => i.id), x: Math.max(...xs), y: Math.min(...ys) } });
        }
        return;
      }
      case 'marquee': {
        const m = marquee;
        setMarquee(null);
        if (!m) {
          setUI({ wsSel: [], wsInkSel: [], popover: null });
          return;
        }
        const items = ws.items.filter((it) => {
          const p = itemPos(ws, it);
          return p.x < m[0] + m[2] && p.x + it.w > m[0] && p.y < m[1] + m[3] && p.y + (it.h ?? 80) > m[1];
        });
        const ink = ws.ink.filter((s) => {
          const b = bbox(s.points);
          return b[0] >= m[0] && b[1] >= m[1] && b[0] + b[2] <= m[0] + m[2] && b[1] + b[3] <= m[1] + m[3];
        });
        setUI({ wsSel: items.map((i) => i.id), wsInkSel: ink.map((s) => s.id) });
        if (items.length || ink.length) setUI({ popover: { kind: 'item', ids: items.map((i) => i.id), x: e.clientX, y: e.clientY } });
        return;
      }
      case 'press': {
        if (cancelled) return;
        // tap on an item
        const lf = ui().linkFrom;
        if (lf) {
          addLink(lf, { kind: 'item', wsId: ws.id, id: st.id });
          setUI({ linkFrom: null });
          useApp.getState().showToast('Linked');
          return;
        }
        const now = Date.now();
        const it = ws.items.find((i) => i.id === st.id);
        if (now - lastTap.current.t < 320 && lastTap.current.id === st.id && it) {
          // double tap: edit text
          setUI({ editingItem: st.id, popover: null });
          lastTap.current = { t: 0, id: '' };
          return;
        }
        lastTap.current = { t: now, id: st.id };
        if (ui().wsSel.length === 1 && ui().wsSel[0] === st.id && ui().popover) {
          setUI({ popover: null });
          return;
        }
        setUI({ wsSel: [st.id], wsInkSel: [], editingItem: ui().editingItem === st.id ? st.id : null, popover: { kind: 'item', ids: [st.id], x: e.clientX, y: e.clientY } });
        return;
      }
      case 'drag': {
        const dd = drag;
        setDrag(null);
        const hint = dockHint;
        setDockHint(null);
        if (!dd || cancelled) return;
        // dropped onto the document? -> create link from card to that doc position
        const docEl = document.elementsFromPoint(e.clientX, e.clientY).find((el) => (el as HTMLElement).dataset?.seg !== undefined) as HTMLElement | undefined;
        if (docEl && st.head) {
          const r = docEl.getBoundingClientRect();
          const sc = r.width / Number(docEl.querySelector('svg')?.viewBox.baseVal.width || r.width);
          const a = anchorAtPoint(e.clientX, e.clientY, paneRef.current!);
          const target = a ?? { kind: 'docpos' as const, docId: docEl.dataset.doc!, page: Number(docEl.dataset.page), x: (e.clientX - r.left) / sc, y: Number(docEl.dataset.y0) + (e.clientY - r.top) / sc };
          addLink({ kind: 'item', wsId: ws.id, id: st.head }, target);
          useApp.getState().showToast('Card linked to document');
          return;
        }
        edit((d) => {
          const wsd = d.workspaces.find((x) => x.id === ws.id)!;
          for (const it of wsd.items) if (dd.ids.includes(it.id) && !(it.dockedTo && dd.ids.includes(it.dockedTo))) {
            it.x += dd.dx;
            it.y += dd.dy;
          }
          for (const s of wsd.ink) if (dd.inkIds.includes(s.id)) s.points = s.points.map((p) => [p[0] + dd.dx, p[1] + dd.dy, p[2]]);
          if (hint && st.head) {
            const head = wsd.items.find((x) => x.id === st.head);
            if (head && head.id !== hint) head.dockedTo = hint;
          }
        });
        return;
      }
      case 'resize': {
        const rz = resize;
        setResize(null);
        if (!rz) return;
        edit((d) => {
          const it = d.workspaces.find((x) => x.id === ws.id)!.items.find((x) => x.id === rz.id);
          if (it) {
            it.w = rz.w;
            if (rz.h) it.h = rz.h;
          }
        });
        return;
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const v = viewRef.current;
    if (e.ctrlKey || e.metaKey) {
      const r = paneRef.current!.getBoundingClientRect();
      const nz = Math.max(0.1, Math.min(4, v.zoom * Math.exp(-e.deltaY * 0.01)));
      const cx = e.clientX - r.left,
        cy = e.clientY - r.top;
      updateView({ zoom: nz, x: cx - ((cx - v.x) / v.zoom) * nz, y: cy - ((cy - v.y) / v.zoom) * nz });
    } else updateView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
  };

  // stack layout: heads render their docked chain beneath them
  const heads = ws.items.filter((i) => !i.dockedTo || !ws.items.some((x) => x.id === i.dockedTo));
  const chain = (id: string): WsItem[] => {
    const out: WsItem[] = [];
    let cur = id;
    for (let i = 0; i < 300; i++) {
      const c = ws.items.find((x) => x.dockedTo === cur);
      if (!c) break;
      out.push(c);
      cur = c.id;
    }
    return out;
  };

  const fingerDraws = !penSeen ? settings.pencilOnly !== 'on' : settings.pencilOnly === 'off';
  void fingerDraws;
  const gridSize = 24 * view.zoom;
  const wsLinks = links.filter((l) => isLocal(l.a, ws) && isLocal(l.b, ws));

  return (
    <div
      ref={paneRef}
      className={`ws-pane tool-${tool}`}
      style={{
        backgroundSize: settings.showDotGrid ? `${gridSize}px ${gridSize}px` : undefined,
        backgroundPosition: `${view.x}px ${view.y}px`,
        backgroundImage: settings.showDotGrid && view.zoom > 0.25 ? undefined : 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => onPointerUp(e)}
      onPointerCancel={(e) => onPointerUp(e, true)}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="ws-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
        <svg className="ws-ink" style={{ overflow: 'visible' }} width="1" height="1">
          {ws.ink.map((s) => {
            const sel = wsInkSel.includes(s.id);
            const dx = drag && drag.inkIds.includes(s.id) ? drag.dx : 0;
            const dy = drag && drag.inkIds.includes(s.id) ? drag.dy : 0;
            return (
              <path
                key={s.id}
                data-anchor={'wsink:' + s.id}
                d={strokeOutline(s.points, s.width, s.kind)}
                transform={dx || dy ? `translate(${dx},${dy})` : undefined}
                className={sel ? 'ink-selected' : undefined}
                {...(s.kind === 'highlighter'
                  ? { fill: 'none', stroke: s.color, strokeWidth: s.width, strokeOpacity: 0.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
                  : { fill: s.color })}
              />
            );
          })}
        </svg>
        {heads.map((h) => {
          const kids = chain(h.id);
          const moving = drag && drag.ids.includes(h.id);
          return (
            <div
              key={h.id}
              className={`ws-stack ${kids.length ? 'has-kids' : ''} ${moving ? 'dragging' : ''}`}
              style={{
                left: h.x + (moving ? drag!.dx : 0),
                top: h.y + (moving ? drag!.dy : 0),
                width: resize && resize.id === h.id ? resize.w : h.w,
              }}
            >
              {[h, ...kids].map((it, i) => (
                <ItemCard
                  key={it.id}
                  item={it}
                  index={i}
                  selected={wsSel.includes(it.id)}
                  editing={editing === it.id}
                  resizeOverride={resize && resize.id === it.id ? resize : null}
                  dockTarget={dockHint === it.id}
                  linked={links.some((l) => anchorKey(l.a) === 'item:' + it.id || anchorKey(l.b) === 'item:' + it.id)}
                  wsId={ws.id}
                />
              ))}
            </div>
          );
        })}
        {marquee && <div className="marquee" style={{ left: marquee[0], top: marquee[1], width: marquee[2], height: marquee[3] }} />}
      </div>
      {wsLinks.length === 0 && ws.items.length === 0 && ws.ink.length === 0 && (
        <div className="ws-empty">
          <div className="ws-empty-title">Workspace</div>
          <div>Select text in the document and drag it here to make an excerpt.</div>
          <div>Double-tap to add a note · Draw with the pen · Pinch to zoom</div>
        </div>
      )}
    </div>
  );
}

function isLocal(a: any, ws: WS) {
  if (a.kind === 'item') return ws.items.some((i) => i.id === a.id);
  if (a.kind === 'wsink') return ws.ink.some((s) => s.id === a.id);
  return false;
}

export function itemPos(ws: WS, it: WsItem): { x: number; y: number } {
  // docked items: compute from the DOM if available, else approximate from parent chain
  if (!it.dockedTo) return { x: it.x, y: it.y };
  const el = document.querySelector(`[data-item-id="${it.id}"]`) as HTMLElement | null;
  let head = it;
  let off = 0;
  for (let i = 0; i < 300 && head.dockedTo; i++) {
    const p = ws.items.find((x) => x.id === head.dockedTo);
    if (!p) break;
    head = p;
    off += 90;
  }
  if (el) {
    const stack = el.parentElement as HTMLElement;
    return { x: head.x, y: head.y + (el.offsetTop - 0) + (stack ? 0 : 0) };
  }
  return { x: head.x, y: head.y + off };
}

function ItemCard({ item, index, selected, editing, resizeOverride, dockTarget, linked, wsId }: {
  item: WsItem;
  index: number;
  selected: boolean;
  editing: boolean;
  resizeOverride: { w: number; h?: number } | null;
  dockTarget: boolean;
  linked: boolean;
  wsId: string;
}) {
  const flashKey = useUI((s) => s.flashKey);
  const flashing = flashKey && flashKey.key === 'item:' + item.id && Date.now() - flashKey.t < 2000;
  const textRef = useRef<HTMLDivElement>(null);
  const docs = useApp((s) => s.project!.data.docs);
  const label = useMemo(() => (item.source ? docLabel(item.source.docId, item.source.page) : ''), [item.source, docs]);

  useEffect(() => {
    if (editing && textRef.current) {
      const el = textRef.current;
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    }
  }, [editing]);

  const commitText = () => {
    const el = textRef.current;
    if (!el) return;
    const val = item.type === 'note' ? el.innerHTML : el.innerText;
    if (val !== item.text)
      edit((d) => {
        const it = d.workspaces.find((w) => w.id === wsId)!.items.find((x) => x.id === item.id);
        if (it) it.text = val;
      });
  };

  const h = resizeOverride?.h ?? item.h;
  return (
    <div
      className={`ws-item ws-${item.type} ${selected ? 'selected' : ''} ${flashing ? 'flash' : ''} ${dockTarget ? 'dock-target' : ''} ${index > 0 ? 'docked' : ''}`}
      data-item-id={item.id}
      data-anchor={'item:' + item.id}
      style={{ ['--accent' as any]: item.color, height: item.type !== 'excerpt' ? h : undefined }}
    >
      <div className="accent-bar" />
      {item.source && (
        <button
          className="src-btn no-ws-gesture"
          title="Show in document"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => goToSource(item)}
        >
          ◀
        </button>
      )}
      {item.type === 'image' && item.image && <img className="ws-img" src={item.image} draggable={false} alt="" />}
      {(item.type !== 'image' || editing || item.text) && (
        <div
          ref={textRef}
          className={`ws-text ${item.type === 'image' ? 'img-caption' : ''}`}
          contentEditable={editing ? true : false}
          suppressContentEditableWarning
          style={{ fontSize: item.fontSize }}
          onBlur={() => {
            commitText();
            if (ui().editingItem === item.id) setUI({ editingItem: null });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.target as HTMLElement).blur();
            e.stopPropagation();
          }}
          {...(item.type === 'note' ? { dangerouslySetInnerHTML: { __html: item.text || (editing ? '' : '<span class="ph">Note</span>') } } : { children: item.type === 'image' && !editing ? item.text.slice(0, 140) : item.text })}
        />
      )}
      {item.source && <div className="ws-src">-{label}</div>}
      {item.tags.length > 0 && (
        <div className="ws-tags">
          {item.tags.map((t) => (
            <span key={t} className="tag">#{t}</span>
          ))}
        </div>
      )}
      {linked && (
        <button
          className="item-link-badge no-ws-gesture"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            const ls = linksFor('item:' + item.id);
            const l = ls[0];
            if (l) goToAnchor(anchorKey(l.a) === 'item:' + item.id ? l.b : l.a);
          }}
          title="Follow link"
        >
          ↗
        </button>
      )}
      {selected && <div className="resize-handle" data-resize={item.id} />}
    </div>
  );
}
