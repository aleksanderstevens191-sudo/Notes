import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from 'react';
import { useApp, uid } from '../store';
import { useUI, setUI, ui, type TextSel } from '../ui';
import { loadDoc, getPageText, renderPage, hitChar, wordAt, sentenceAt, rangeRects, rangeText, cropPage, type LoadedDoc } from '../pdf';
import type { Comment, DocStroke, Fold, Highlight, Rect, Bookmark } from '../types';
import { hlFill } from '../types';
import { strokeOutline, strokeHit, eraseFromStroke, simplify, pointInPoly, strokeInPoly, isConnectorLike, polyBBox } from '../ink';
import { liveStart, liveAdd, liveEnd } from '../liveInk';
import { pointerDraws, notePointer, setGestureLock, coalesced, pressureOf } from '../input';
import {
  selectionSegments, createExcerpt, anchorAtPoint, docPosAt, addLink, edit, hitRects, linksFor, goToAnchor, data, createHighlight,
} from '../actions';
import { anchorKey } from '../ui';
import { linkAtPoint } from './LinkOverlay';

const PAGE_GAP = 14;
const MARGIN_L = 34;
const MARGIN_R = 14;

interface Seg {
  type: 'seg';
  page: number;
  y0: number;
  y1: number;
  first: boolean;
}
interface FoldItem {
  type: 'fold';
  from: number;
  to: number;
  persisted: string[];
}
type LayoutItem = Seg | FoldItem;

function mergeFolds(folds: { from: number; to: number; id?: string }[]) {
  const s = [...folds].sort((a, b) => a.from - b.from);
  const out: { from: number; to: number; ids: string[] }[] = [];
  for (const f of s) {
    const l = out[out.length - 1];
    if (l && f.from <= l.to + 0.002) {
      l.to = Math.max(l.to, f.to);
      if (f.id) l.ids.push(f.id);
    } else out.push({ from: f.from, to: f.to, ids: f.id ? [f.id] : [] });
  }
  return out;
}

export function DocView({ docId, width }: { docId: string; width: number }) {
  const doc = useApp((s) => s.project!.data.docs.find((d) => d.id === docId));
  const [ld, setLd] = useState<LoadedDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const zoom = useUI((s) => s.zoom[docId] ?? 1);
  const collapsed = useUI((s) => !!s.collapsed[docId]);
  const folds = useApp((s) => s.project!.data.folds[docId]);
  const highlights = useApp((s) => s.project!.data.highlights);
  const docInk = useApp((s) => s.project!.data.docInk);
  const comments = useApp((s) => s.project!.data.comments);
  const bookmarks = useApp((s) => s.project!.data.bookmarks);
  const links = useApp((s) => s.project!.data.links);
  const tool = useApp((s) => s.tool);
  const settings = useApp((s) => s.settings);
  const penSeen = useApp((s) => s.penSeen);
  const sel = useUI((s) => (s.sel?.docId === docId ? s.sel : null));
  const search = useUI((s) => s.search);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [flashRects, setFlashRects] = useState<{ page: number; rects: Rect[]; t: number } | null>(null);
  const [lassoSel, setLassoSel] = useState<{ page: number; ids: string[]; rect: Rect; dx: number; dy: number } | null>(null);
  const [pinchBand, setPinchBand] = useState<{ top: number; bottom: number } | null>(null);
  const [liveZoom, setLiveZoom] = useState<{ k: number; ox: number; oy: number } | null>(null);
  const [scrollTick, setScrollTick] = useState(0);

  useEffect(() => {
    if (!doc) return;
    let alive = true;
    loadDoc(doc.fileId)
      .then(async (d) => {
        // warm text for all pages (search, selection)
        if (alive) setLd(d);
        for (let i = 0; i < d.pages.length; i++) await getPageText(d, i);
        if (alive) setLd({ ...d });
      })
      .catch((e) => alive && setErr(String(e?.message || e)));
    return () => {
      alive = false;
    };
  }, [doc?.fileId]);

  const maxW = useMemo(() => (ld ? Math.max(...ld.pages.map((p) => p.width)) : 612), [ld]);
  const s = Math.max(0.1, ((width - MARGIN_L - MARGIN_R) / maxW) * zoom);

  // ------- layout with folds / collapse -------
  const layout: LayoutItem[] = useMemo(() => {
    if (!ld) return [];
    const n = ld.pages.length;
    const all: { from: number; to: number; id?: string }[] = (folds || []).map((f) => ({ ...f }));
    if (collapsed) {
      // keep only regions around annotations
      const keep: [number, number][] = [];
      const pad = 0.025;
      for (const h of highlights) if (h.docId === docId) for (const sg of h.segments) {
        const H = ld.pages[sg.page].height;
        for (const r of sg.rects) keep.push([sg.page + r[1] / H - pad, sg.page + (r[1] + r[3]) / H + pad]);
      }
      for (const st of docInk) if (st.docId === docId) {
        const H = ld.pages[st.page].height;
        const ys = st.points.map((p) => p[1]);
        keep.push([st.page + Math.min(...ys) / H - pad, st.page + Math.max(...ys) / H + pad]);
      }
      for (const c of comments) if (c.docId === docId) keep.push([c.page + c.y / ld.pages[c.page].height - pad, c.page + c.y / ld.pages[c.page].height + pad * 2]);
      for (const b of bookmarks) if (b.docId === docId) keep.push([b.page + b.y / ld.pages[b.page].height - pad, b.page + b.y / ld.pages[b.page].height + pad * 2]);
      keep.sort((a, b) => a[0] - b[0]);
      let cur = 0;
      const merged: [number, number][] = [];
      for (const k of keep) {
        const l = merged[merged.length - 1];
        if (l && k[0] <= l[1]) l[1] = Math.max(l[1], k[1]);
        else merged.push([...k] as [number, number]);
      }
      for (const k of merged) {
        if (k[0] > cur + 0.01) all.push({ from: cur, to: Math.max(cur, k[0]) });
        cur = Math.max(cur, k[1]);
      }
      if (cur < n - 0.001) all.push({ from: cur, to: n });
    }
    const mf = mergeFolds(all.map((f) => ({ ...f, from: Math.max(0, f.from), to: Math.min(n, f.to) })).filter((f) => f.to - f.from > 0.004));
    const out: LayoutItem[] = [];
    for (let p = 0; p < n; p++) {
      const H = ld.pages[p].height;
      let cur = p;
      let first = true;
      for (const f of mf) {
        if (f.to <= p || f.from >= p + 1) continue;
        if (f.from > cur + 1e-6) {
          out.push({ type: 'seg', page: p, y0: (cur - p) * H, y1: (f.from - p) * H, first });
          first = false;
        }
        if (f.from >= p - 1e-9 || (p === 0 && f.from <= 0)) out.push({ type: 'fold', from: f.from, to: f.to, persisted: f.ids });
        cur = Math.max(cur, f.to);
      }
      if (cur < p + 1 - 1e-6) out.push({ type: 'seg', page: p, y0: (cur - p) * H, y1: H, first });
    }
    return out;
  }, [ld, folds, collapsed, highlights, docInk, comments, bookmarks, docId]);

  // group annotations by page
  const byPage = useMemo(() => {
    const m = new Map<number, { hl: Highlight[]; ink: DocStroke[]; com: Comment[]; bm: Bookmark[] }>();
    const g = (p: number) => {
      let v = m.get(p);
      if (!v) m.set(p, (v = { hl: [], ink: [], com: [], bm: [] }));
      return v;
    };
    for (const h of highlights) if (h.docId === docId) for (const sg of h.segments) g(sg.page).hl.push(h);
    for (const st of docInk) if (st.docId === docId) g(st.page).ink.push(st);
    for (const c of comments) if (c.docId === docId) g(c.page).com.push(c);
    for (const b of bookmarks) if (b.docId === docId) g(b.page).bm.push(b);
    return m;
  }, [highlights, docInk, comments, bookmarks, docId]);

  const linkedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const l of links) {
      set.add(anchorKey(l.a));
      set.add(anchorKey(l.b));
    }
    return set;
  }, [links]);

  const selByPage = useMemo(() => {
    const m = new Map<number, Rect[]>();
    if (!sel || !ld) return m;
    const { segments } = selectionSegments(sel);
    for (const sg of segments) m.set(sg.page, sg.rects);
    return m;
  }, [sel, ld]);

  const searchByPage = useMemo(() => {
    const m = new Map<number, { rects: Rect[]; active: boolean }[]>();
    if (!search.open || !ld) return m;
    search.hits.forEach((h, i) => {
      if (h.docId !== docId) return;
      const arr = m.get(h.page) || [];
      arr.push({ rects: hitRects(h), active: i === search.active });
      m.set(h.page, arr);
    });
    return m;
  }, [search, ld, docId]);

  // ------- coordinate mapping -------
  const segEls = () => Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-seg]') || []);
  const hit = (cx: number, cy: number, clamp = false) => {
    let best: { page: number; x: number; y: number; el: HTMLElement } | null = null;
    let bd = Infinity;
    for (const el of segEls()) {
      const r = el.getBoundingClientRect();
      const page = Number(el.dataset.page);
      const y0 = Number(el.dataset.y0);
      if (cy >= r.top && cy <= r.bottom && cx >= r.left - 30 && cx <= r.right + 30) {
        return { page, x: (cx - r.left) / s, y: y0 + (cy - r.top) / s, el };
      }
      if (clamp) {
        const d = cy < r.top ? r.top - cy : cy - r.bottom;
        if (d < bd) {
          bd = d;
          const yy = Math.max(r.top, Math.min(r.bottom, cy));
          best = { page, x: (cx - r.left) / s, y: y0 + (yy - r.top) / s, el };
        }
      }
    }
    return best;
  };
  const toClient = (page: number, x: number, y: number) => {
    for (const el of segEls()) {
      if (Number(el.dataset.page) !== page) continue;
      const y0 = Number(el.dataset.y0), y1 = Number(el.dataset.y1);
      if (y < y0 - 0.5 || y > y1 + 0.5) continue;
      const r = el.getBoundingClientRect();
      return { x: r.left + x * s, y: r.top + (y - y0) * s };
    }
    return null;
  };
  const charAt = (cx: number, cy: number) => {
    const h = hit(cx, cy, true);
    if (!h || !ld) return null;
    const pt = ld.textReady.get(h.page);
    if (!pt || !pt.chars.length) return null;
    return { page: h.page, idx: hitChar(pt, h.x, h.y), h };
  };
  const onText = (cx: number, cy: number, tol = 2) => {
    const h = hit(cx, cy);
    if (!h || !ld) return false;
    const pt = ld.textReady.get(h.page);
    if (!pt) return false;
    return pt.lines.some((L) => h.y >= L.y - tol && h.y <= L.y + L.h + tol && h.x >= L.x0 - 4 - tol && h.x <= L.x1 + 4 + tol);
  };
  const inSelection = (cx: number, cy: number) => {
    const h = hit(cx, cy);
    if (!h) return false;
    const rects = selByPage.get(h.page);
    return !!rects?.some((r) => h.x >= r[0] - 4 && h.x <= r[0] + r[2] + 4 && h.y >= r[1] - 4 && h.y <= r[1] + r[3] + 4);
  };
  const hlAt = (cx: number, cy: number): Highlight | null => {
    const h = hit(cx, cy);
    if (!h) return null;
    const list = byPage.get(h.page)?.hl || [];
    for (let i = list.length - 1; i >= 0; i--) {
      const hl = list[i];
      for (const sg of hl.segments) if (sg.page === h.page) for (const r of sg.rects)
        if (h.x >= r[0] - 2 && h.x <= r[0] + r[2] + 2 && h.y >= r[1] - 2 && h.y <= r[1] + r[3] + 2) return hl;
    }
    return null;
  };

  // ------- scrolling requests & position tracking -------
  const scrollReq = useUI((s) => s.scrollReq);
  useEffect(() => {
    if (!scrollReq || scrollReq.docId !== docId || !ld) return;
    const sc = scrollRef.current!;
    const target = segEls().find((el) => Number(el.dataset.page) === scrollReq.page && Number(el.dataset.y0) <= scrollReq.y + 0.5 && Number(el.dataset.y1) >= scrollReq.y - 0.5)
      || segEls().find((el) => Number(el.dataset.page) === scrollReq.page);
    if (target) {
      const top = target.offsetTop + (scrollReq.y - Number(target.dataset.y0)) * s - sc.clientHeight * 0.3;
      sc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
    if (scrollReq.flash) setFlashRects({ page: scrollReq.page, rects: scrollReq.flash, t: scrollReq.t });
  }, [scrollReq, ld]);

  useEffect(() => {
    if (!flashRects) return;
    const t = setTimeout(() => setFlashRects(null), 1800);
    return () => clearTimeout(t);
  }, [flashRects]);

  const topU = useRef(0);
  const updateU = () => {
    const sc = scrollRef.current;
    if (!sc || !ld) return;
    const st = sc.scrollTop;
    for (const el of segEls()) {
      if (el.offsetTop + el.offsetHeight >= st) {
        const page = Number(el.dataset.page);
        const y0 = Number(el.dataset.y0);
        const y = y0 + Math.max(0, st - el.offsetTop) / s;
        topU.current = page + y / ld.pages[page].height;
        sc.dataset.u = String(topU.current);
        return;
      }
    }
  };
  // keep reading position stable across zoom / fold changes
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !ld) return;
    const u = topU.current;
    const page = Math.floor(u);
    const y = (u - page) * (ld.pages[page]?.height ?? 0);
    const el = segEls().find((e) => Number(e.dataset.page) === page && Number(e.dataset.y0) <= y + 0.5 && Number(e.dataset.y1) >= y - 0.5);
    if (el) sc.scrollTop = el.offsetTop + (y - Number(el.dataset.y0)) * s;
  }, [s, layout.length]);

  const onScroll = () => {
    updateU();
    setScrollTick((t) => t + 1);
    if (ui().popover && ui().popover!.kind !== 'comment') setUI({ popover: null });
  };

  // ------- gestures -------
  const g = useRef<any>({ mode: 'idle' });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastTap = useRef({ t: 0, x: 0, y: 0, n: 0 });

  const fingerDraws = !penSeen ? settings.pencilOnly !== 'on' : settings.pencilOnly === 'off';
  const drawTool = tool === 'pen' || tool === 'highlighter' || tool === 'eraser' || tool === 'lasso';
  const touchAction = drawTool && fingerDraws ? 'none' : 'pan-x pan-y';

  const startDragExcerpt = (cx: number, cy: number) => {
    const cur = ui().sel;
    if (!cur) return;
    const { text } = selectionSegments(cur);
    g.current = { mode: 'dragExcerpt', sel: cur };
    setGestureLock(true);
    setUI({ drag: { text, x: cx, y: cy, kind: 'text' }, popover: null });
  };

  const openSelMenu = () => {
    const cur = ui().sel;
    if (!cur) return;
    const { segments } = selectionSegments(cur);
    const last = segments[segments.length - 1];
    if (!last) return;
    const r = last.rects[last.rects.length - 1];
    const c = toClient(last.page, r[0] + r[2], r[1] + r[3]);
    const f = segments[0];
    const c0 = toClient(f.page, f.rects[0][0], f.rects[0][1]);
    setUI({ popover: { kind: 'selection', x: c ? c.x : 200, y: c0 ? c0.y : c ? c.y : 200 } });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    notePointer(e);
    const target = e.target as HTMLElement;
    if (target.closest('.no-doc-gesture')) return;
    if (e.isPrimary) pointers.current.clear(); // first finger down: forget any stale pointers
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType === 'touch' && pointers.current.size === 2) {
      // start pinch
      if (g.current.timer) clearTimeout(g.current.timer);
      if (g.current.mode === 'ink' || g.current.mode === 'lasso' || g.current.mode === 'erase') liveEnd();
      const [a, b] = Array.from(pointers.current.values());
      const vertical = Math.abs(a.y - b.y) > Math.abs(a.x - b.x) * 1.3;
      g.current = { mode: 'pinch', a0: { ...a }, b0: { ...b }, d0: Math.hypot(a.x - b.x, a.y - b.y), vertical, z0: zoom };
      setGestureLock(true);
      return;
    }
    if (pointers.current.size > 2) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    // selection handles
    const handle = target.closest('[data-handle]') as HTMLElement | null;
    if (handle && ui().sel) {
      g.current = { mode: 'handle', which: handle.dataset.handle };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setGestureLock(true);
      e.preventDefault();
      return;
    }
    // comment markers & link badges handled by their own click handlers
    if (target.closest('[data-comment-marker],[data-link-badge],[data-bm-marker],.fold-bar')) return;

    const draws = pointerDraws(e.nativeEvent);
    // moving lasso-selected ink
    if (lassoSel && (tool === 'lasso' || tool === 'select')) {
      const h = hit(e.clientX, e.clientY);
      const r = lassoSel.rect;
      if (h && h.page === lassoSel.page && h.x >= r[0] && h.x <= r[0] + r[2] && h.y >= r[1] && h.y <= r[1] + r[3]) {
        g.current = { mode: 'moveInk', sx: e.clientX, sy: e.clientY };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setGestureLock(true);
        return;
      }
      setLassoSel(null);
    }

    if ((tool === 'pen' || tool === 'highlighter') && draws) {
      const h = hit(e.clientX, e.clientY, true);
      if (!h) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setGestureLock(true);
      if (tool === 'highlighter' && onText(e.clientX, e.clientY)) {
        const c = charAt(e.clientX, e.clientY)!;
        g.current = { mode: 'hlText', anchor: { page: c.page, idx: c.idx } };
        setUI({ sel: { docId, anchor: { page: c.page, idx: c.idx }, focus: { page: c.page, idx: c.idx } }, popover: null });
        return;
      }
      const color = tool === 'pen' ? settings.penColor : settings.hlInkColor;
      const w = tool === 'pen' ? settings.penWidth : settings.hlInkWidth;
      liveStart(tool, color, w * s);
      liveAdd(e.clientX, e.clientY, pressureOf(e.nativeEvent));
      g.current = { mode: 'ink', page: h.page, startAnchor: anchorAtPoint(e.clientX, e.clientY), color, w };
      return;
    }
    if (tool === 'eraser' && draws) {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setGestureLock(true);
      g.current = { mode: 'erase', key: 'erase-' + uid() };
      liveStart('eraser', '#999', 18);
      eraseAt(e.clientX, e.clientY);
      return;
    }
    if (tool === 'lasso' && draws) {
      const h = hit(e.clientX, e.clientY, true);
      if (!h) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setGestureLock(true);
      liveStart('lasso', '#5b6bff', 1);
      liveAdd(e.clientX, e.clientY, 0.5);
      g.current = { mode: 'lasso', page: h.page };
      return;
    }

    // ---- select (text) tool, or finger in drawing tools ----
    if (e.pointerType === 'touch') {
      const start = { x: e.clientX, y: e.clientY };
      g.current = { mode: 'touchPending', start, moved: false };
      g.current.timer = setTimeout(() => {
        if (g.current.mode !== 'touchPending' || g.current.moved) return;
        if (tool !== 'select') return;
        if (inSelection(start.x, start.y)) {
          startDragExcerpt(start.x, start.y);
          return;
        }
        const c = charAt(start.x, start.y);
        if (!c || !onText(start.x, start.y, 10)) return;
        const pt = ld!.textReady.get(c.page)!;
        const [a, b] = wordAt(pt, c.idx);
        setUI({ sel: { docId, anchor: { page: c.page, idx: a }, focus: { page: c.page, idx: Math.max(a, b - 1) } }, popover: null });
        g.current = { mode: 'selecting', anchor: { page: c.page, idx: a }, wordEnd: Math.max(a, b - 1), moved: true };
        setGestureLock(true);
        try {
          (navigator as any).vibrate?.(10);
        } catch {
          /* */
        }
      }, 380);
      return;
    }
    // mouse / pencil in select mode
    if (tool !== 'select' && !draws) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setGestureLock(true);
    if (inSelection(e.clientX, e.clientY)) {
      g.current = { mode: 'maybeDrag', sx: e.clientX, sy: e.clientY };
      return;
    }
    const c = charAt(e.clientX, e.clientY);
    g.current = { mode: 'maybeSelect', sx: e.clientX, sy: e.clientY, c, onText: onText(e.clientX, e.clientY) };
  };

  const eraseAt = (cx: number, cy: number) => {
    liveAdd(cx, cy, 0.5);
    const h = hit(cx, cy);
    if (!h) return;
    const r = 8 / s;
    const page = h.page;
    const list = byPage.get(page);
    if (!list) return;
    const hitInk = list.ink.filter((st) => strokeHit(st, h.x, h.y, r));
    const hitHl = list.hl.filter((hl) => hl.kind !== 'excerpt' && hl.segments.some((sg) => sg.page === page && sg.rects.some((rc) => h.x >= rc[0] && h.x <= rc[0] + rc[2] && h.y >= rc[1] && h.y <= rc[1] + rc[3])));
    if (!hitInk.length && !hitHl.length) return;
    edit((d) => {
      if (settings.eraserMode === 'point') {
        for (const st of hitInk) {
          const pieces = eraseFromStroke(st, h.x, h.y, r);
          if (!pieces) continue;
          const idx = d.docInk.findIndex((x) => x.id === st.id);
          if (idx < 0) continue;
          d.docInk.splice(idx, 1, ...pieces.map((pts) => ({ ...st, id: uid(), points: pts })));
        }
      } else {
        const ids = new Set(hitInk.map((x) => x.id));
        d.docInk = d.docInk.filter((x) => !ids.has(x.id));
      }
      const hids = new Set(hitHl.map((x) => x.id));
      d.highlights = d.highlights.filter((x) => !hids.has(x.id));
      d.comments = d.comments.filter((c) => !c.hlId || !hids.has(c.hlId));
    }, { coalesce: g.current.key });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = g.current;
    switch (st.mode) {
      case 'pinch': {
        const ps = Array.from(pointers.current.values());
        if (ps.length < 2) return;
        const [a, b] = ps;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (st.vertical) {
          const sc = scrollRef.current!.getBoundingClientRect();
          const top = Math.min(st.a0.y, st.b0.y) - sc.top;
          const bottom = Math.max(st.a0.y, st.b0.y) - sc.top;
          const ratio = Math.max(0.05, Math.min(1, d / st.d0));
          const mid = (top + bottom) / 2;
          const half = ((bottom - top) / 2) * ratio;
          setPinchBand({ top: mid - half, bottom: mid + half });
          st.ratio = ratio;
        } else {
          const k = d / st.d0;
          const sc = scrollRef.current!;
          const r = sc.getBoundingClientRect();
          const ox = (st.a0.x + st.b0.x) / 2 - r.left + sc.scrollLeft;
          const oy = (st.a0.y + st.b0.y) / 2 - r.top + sc.scrollTop;
          setLiveZoom({ k: Math.max(0.4 / st.z0, Math.min(5 / st.z0, k)), ox, oy });
        }
        return;
      }
      case 'touchPending': {
        if (Math.hypot(e.clientX - st.start.x, e.clientY - st.start.y) > 8) {
          st.moved = true;
          clearTimeout(st.timer);
          // in drawing tools with finger drawing disabled, fingers scroll natively
        }
        return;
      }
      case 'ink': {
        for (const ce of coalesced(e.nativeEvent)) liveAdd(ce.clientX, ce.clientY, pressureOf(ce));
        return;
      }
      case 'erase':
        for (const ce of coalesced(e.nativeEvent)) eraseAt(ce.clientX, ce.clientY);
        return;
      case 'lasso':
        liveAdd(e.clientX, e.clientY, 0.5);
        return;
      case 'moveInk': {
        setLassoSel((ls) => (ls ? { ...ls, dx: (e.clientX - st.sx) / s, dy: (e.clientY - st.sy) / s } : ls));
        return;
      }
      case 'maybeDrag':
        if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) > 6) startDragExcerpt(e.clientX, e.clientY);
        return;
      case 'dragExcerpt':
        setUI({ drag: { ...ui().drag!, x: e.clientX, y: e.clientY } });
        autoScroll(e.clientY);
        return;
      case 'maybeSelect': {
        if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) < 5) return;
        if (!st.c) return;
        g.current = { mode: 'selecting', anchor: { page: st.c.page, idx: st.c.idx } };
        setUI({ popover: null });
      }
      // falls through
      case 'selecting':
      case 'hlText': {
        const c = charAt(e.clientX, e.clientY);
        if (!c || !ld) return;
        const a = g.current.anchor;
        const before = c.page < a.page || (c.page === a.page && c.idx < a.idx);
        // snap to whole words (anchor word start / focus word end), like iPadOS
        const ptA = ld.textReady.get(a.page)!;
        const ptF = ld.textReady.get(c.page)!;
        const [aw0, aw1] = wordAt(ptA, a.idx);
        const [fw0, fw1] = wordAt(ptF, c.idx);
        let anchor = { page: a.page, idx: before ? Math.max(aw0, aw1 - 1) : aw0 };
        if (g.current.wordEnd != null && before) anchor = { page: a.page, idx: g.current.wordEnd };
        const focus = { page: c.page, idx: before ? fw0 : Math.max(fw0, fw1 - 1) };
        setUI({ sel: { docId, anchor, focus } });
        autoScroll(e.clientY);
        return;
      }
      case 'handle': {
        const c = charAt(e.clientX, e.clientY);
        const cur = ui().sel;
        if (!c || !cur) return;
        const [a, b] = orderedSel(cur);
        if (st.which === 'start') setUI({ sel: { docId, anchor: b, focus: { page: c.page, idx: c.idx } } });
        else setUI({ sel: { docId, anchor: a, focus: { page: c.page, idx: Math.max(0, c.idx - 1) } } });
        autoScroll(e.clientY);
        return;
      }
    }
  };

  const autoScroll = (cy: number) => {
    const sc = scrollRef.current;
    if (!sc) return;
    const r = sc.getBoundingClientRect();
    if (cy < r.top + 40) sc.scrollTop -= 14;
    else if (cy > r.bottom - 40) sc.scrollTop += 14;
  };

  const finish = (e: React.PointerEvent, cancelled = false) => {
    pointers.current.delete(e.pointerId);
    const st = g.current;
    if (st.mode === 'pinch') {
      if (pointers.current.size > 0) return; // wait until all fingers are lifted
      setGestureLock(false);
      if (st.vertical) {
        setPinchBand(null);
        if (st.ratio && st.ratio < 0.6 && !cancelled) {
          const a = hit(st.a0.x, Math.min(st.a0.y, st.b0.y), true);
          const b = hit(st.b0.x, Math.max(st.a0.y, st.b0.y), true);
          if (a && b && ld) {
            // snap fold edges to text line boundaries so no line is cut in half
            const snap = (page: number, y: number, dir: 'up' | 'down') => {
              const pt = ld.textReady.get(page);
              if (!pt) return y;
              for (const L of pt.lines) {
                if (y > L.y && y < L.y + L.h) return dir === 'up' ? L.y + L.h + 1 : L.y - 1;
              }
              return y;
            };
            const ua = a.page + snap(a.page, a.y, 'up') / ld.pages[a.page].height;
            const ub = b.page + snap(b.page, b.y, 'down') / ld.pages[b.page].height;
            if (ub - ua > 0.01) {
              edit((d) => {
                (d.folds[docId] ||= []).push({ id: uid(), from: ua, to: ub });
              });
            }
          }
        }
      } else if (liveZoom) {
        const nz = Math.max(0.4, Math.min(5, st.z0 * liveZoom.k));
        setLiveZoom(null);
        setUI({ zoom: { ...ui().zoom, [docId]: nz } });
      }
      g.current = { mode: 'idle' };
      return;
    }
    setGestureLock(false);
    g.current = { mode: 'idle' };
    switch (st.mode) {
      case 'touchPending': {
        clearTimeout(st.timer);
        if (!st.moved && !cancelled) tap(e.clientX, e.clientY, e);
        return;
      }
      case 'maybeSelect':
      case 'maybeDrag':
        if (!cancelled) tap(e.clientX, e.clientY, e);
        return;
      case 'selecting':
        if (ui().sel) openSelMenu();
        return;
      case 'handle':
        openSelMenu();
        return;
      case 'hlText': {
        const cur = ui().sel;
        if (cur && !cancelled) createHighlight(cur, settings.hlColor);
        setUI({ sel: null });
        return;
      }
      case 'dragExcerpt':
        dropExcerpt(e.clientX, e.clientY, st.sel);
        return;
      case 'ink': {
        const pts = liveEnd();
        if (cancelled || !pts.length) return;
        commitInk(pts, st);
        return;
      }
      case 'erase':
        liveEnd();
        return;
      case 'lasso': {
        const pts = liveEnd();
        if (cancelled || pts.length < 3) return;
        finishLasso(pts, st.page);
        return;
      }
      case 'moveInk': {
        const ls = lassoSel;
        if (ls && (ls.dx || ls.dy)) {
          edit((d) => {
            for (const stk of d.docInk) if (ls.ids.includes(stk.id)) stk.points = stk.points.map((p) => [p[0] + ls.dx, p[1] + ls.dy, p[2]]);
          });
          setLassoSel({ ...ls, rect: [ls.rect[0] + ls.dx, ls.rect[1] + ls.dy, ls.rect[2], ls.rect[3]], dx: 0, dy: 0 });
        }
        return;
      }
    }
  };

  const tap = (cx: number, cy: number, e: React.PointerEvent) => {
    const now = Date.now();
    const lt = lastTap.current;
    const multi = now - lt.t < 330 && Math.hypot(cx - lt.x, cy - lt.y) < 20;
    lastTap.current = { t: now, x: cx, y: cy, n: multi ? lt.n + 1 : 1 };
    const n = lastTap.current.n;
    if (n >= 2 && tool === 'select') {
      const c = charAt(cx, cy);
      if (c && ld) {
        const pt = ld.textReady.get(c.page)!;
        const [a, b] = n === 2 ? wordAt(pt, c.idx) : sentenceAt(pt, c.idx);
        setUI({ sel: { docId, anchor: { page: c.page, idx: a }, focus: { page: c.page, idx: Math.max(a, b - 1) } } });
        setTimeout(openSelMenu, 0);
        return;
      }
    }
    // link mode completion
    const lf = ui().linkFrom;
    if (lf) {
      const a = anchorAtPoint(cx, cy);
      const h = hit(cx, cy);
      const target = a ?? (h ? { kind: 'docpos' as const, docId, page: h.page, x: h.x, y: h.y } : null);
      if (target) addLink(lf, target);
      setUI({ linkFrom: null });
      useApp.getState().showToast('Linked');
      return;
    }
    const lk = linkAtPoint(cx, cy);
    if (lk) {
      setUI({ popover: { kind: 'link', id: lk, x: cx, y: cy } });
      return;
    }
    const hl = hlAt(cx, cy);
    if (hl) {
      setUI({ sel: null, popover: { kind: 'highlight', id: hl.id, x: cx, y: cy } });
      return;
    }
    if (ui().sel || ui().popover) setUI({ sel: null, popover: null });
    setUI({ activeDoc: docId });
  };

  const dropExcerpt = (cx: number, cy: number, s0: TextSel) => {
    setUI({ drag: null });
    const wsEl = document.querySelector('.ws-pane') as HTMLElement | null;
    if (!wsEl) return;
    const r = wsEl.getBoundingClientRect();
    if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) {
      openSelMenu();
      return;
    }
    const d = data();
    const ws = d.workspaces.find((w) => w.id === d.activeWs)!;
    const x = (cx - r.left - ws.view.x) / ws.view.zoom - 20;
    const y = (cy - r.top - ws.view.y) / ws.view.zoom - 16;
    // dock onto a card if dropped on its lower edge
    let dock: string | undefined;
    const under = document.elementsFromPoint(cx, cy).find((el) => (el as HTMLElement).dataset?.itemId) as HTMLElement | undefined;
    if (under && settings.snapExcerpts) {
      const ur = under.getBoundingClientRect();
      if (cy > ur.top + ur.height * 0.5) dock = lastInStack(under.dataset.itemId!);
    }
    const id = createExcerpt(s0, { x, y }, dock);
    setUI({ sel: null, popover: null, wsSel: id ? [id] : [] });
  };

  const commitInk = (pts: [number, number, number][], st: any) => {
    // ink link: stroke from one object to another
    if (settings.linkByInk && isConnectorLike(pts)) {
      const last = pts[pts.length - 1];
      const b = anchorAtPoint(last[0], last[1]);
      // a line that leaves the document and ends on a card links from that spot in the text
      const pane = scrollRef.current!.getBoundingClientRect();
      const leftPane = last[0] < pane.left || last[0] > pane.right || last[1] < pane.top || last[1] > pane.bottom;
      const a = st.startAnchor ?? (b && leftPane ? docPosAt(pts[0][0], pts[0][1]) : null);
      if (a && b && anchorKey(a) !== anchorKey(b)) {
        addLink(a, b, st.color);
        useApp.getState().showToast('Linked');
        return;
      }
    }
    // convert to page coords (relative to the page where the stroke started)
    const first = pts[0];
    const h = hit(first[0], first[1], true);
    if (!h) return;
    const el = h.el;
    const r = el.getBoundingClientRect();
    const y0 = Number(el.dataset.y0);
    const pagePts = simplify(pts.map((p) => [(p[0] - r.left) / s, y0 + (p[1] - r.top) / s, p[2]] as [number, number, number]), 0.4);
    edit((d) => {
      d.docInk.push({ id: uid(), docId, page: h.page, points: pagePts, color: st.color, width: st.w, kind: tool === 'highlighter' ? 'highlighter' : 'pen' });
    });
  };

  const finishLasso = (pts: [number, number, number][], page: number) => {
    const el = segEls().find((e) => Number(e.dataset.page) === page);
    const h0 = hit(pts[0][0], pts[0][1], true);
    const segEl = h0?.el || el;
    if (!segEl || !ld) return;
    const r = segEl.getBoundingClientRect();
    const y0 = Number(segEl.dataset.y0);
    const poly = pts.map((p) => [(p[0] - r.left) / s, y0 + (p[1] - r.top) / s] as [number, number]);
    const pg = h0 ? h0.page : page;
    const ink = (byPage.get(pg)?.ink || []).filter((stk) => strokeInPoly(stk, poly));
    const rect = polyBBox(poly);
    const pr: Rect = [Math.max(0, rect[0]), Math.max(0, rect[1]), Math.min(ld.pages[pg].width, rect[0] + rect[2]) - Math.max(0, rect[0]), Math.min(ld.pages[pg].height, rect[1] + rect[3]) - Math.max(0, rect[1])];
    if (pr[2] < 4 || pr[3] < 4) return;
    if (ink.length) setLassoSel({ page: pg, ids: ink.map((x) => x.id), rect: polyBBox(ink.flatMap((x) => x.points.map((p) => [p[0], p[1]] as [number, number]))), dx: 0, dy: 0 });
    const last = pts[pts.length - 1];
    setUI({ popover: { kind: 'lassoDoc', docId, page: pg, rect: pr, strokeIds: ink.map((x) => x.id), x: Math.max(...pts.map((p) => p[0])), y: Math.min(...pts.map((p) => p[1])) } });
    void last;
    void pointInPoly;
  };

  // helper exposed for popovers
  useEffect(() => {
    const fn = (ev: Event) => {
      const det = (ev as CustomEvent).detail;
      if (det?.docId !== docId) return;
      if (det.action === 'clearLasso') setLassoSel(null);
    };
    window.addEventListener('doc-action', fn);
    return () => window.removeEventListener('doc-action', fn);
  }, [docId]);

  // render page bitmaps of visible segments
  const [visible, setVisible] = useState<Set<string>>(new Set());
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const n = new Set(prev);
          for (const en of entries) {
            const k = (en.target as HTMLElement).dataset.key!;
            if (en.isIntersecting) n.add(k);
            else n.delete(k);
          }
          return n;
        });
      },
      { root: sc, rootMargin: '600px 0px' },
    );
    segEls().forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [layout, s]);

  if (err) return <div className="doc-error">Could not open document: {err}</div>;
  if (!doc) return null;

  const contentW = maxW * s + MARGIN_L + MARGIN_R;
  const pageCount = ld?.pages.length ?? doc.pageCount;

  return (
    <div className="doc-view" data-doc={docId}>
      <div
        ref={scrollRef}
        className="doc-scroll"
        data-doc={docId}
        style={{ touchAction }}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e)}
        onPointerCancel={(e) => finish(e, true)}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const nz = Math.max(0.4, Math.min(5, zoom * Math.exp(-e.deltaY * 0.01)));
            setUI({ zoom: { ...ui().zoom, [docId]: nz } });
          }
        }}
      >
        <div
          ref={contentRef}
          className="doc-content"
          style={{
            width: Math.max(contentW, width),
            transform: liveZoom ? `scale(${liveZoom.k})` : undefined,
            transformOrigin: liveZoom ? `${liveZoom.ox}px ${liveZoom.oy}px` : undefined,
          }}
        >
          {!ld && <div className="doc-loading">Opening…</div>}
          {ld &&
            layout.map((it, i) => {
              if (it.type === 'fold') {
                return (
                  <FoldBar
                    key={'f' + it.from}
                    item={it}
                    width={maxW * s}
                    onOpen={() => {
                      if (it.persisted.length)
                        edit((d) => {
                          d.folds[docId] = (d.folds[docId] || []).filter((f) => !it.persisted.includes(f.id) && !(f.from >= it.from - 1e-6 && f.to <= it.to + 1e-6));
                        });
                      else setUI({ collapsed: { ...ui().collapsed, [docId]: false } });
                    }}
                  />
                );
              }
              const pg = ld.pages[it.page];
              const pageData = byPage.get(it.page);
              const next = layout[i + 1];
              const gap = !next || (next.type === 'seg' && next.page !== it.page) ? PAGE_GAP : 0;
              return (
                <PageSeg
                  key={`${it.page}:${it.y0}`}
                  ld={ld}
                  docId={docId}
                  seg={it}
                  s={s}
                  pw={pg.width}
                  gap={gap}
                  visible={visible.has(`${it.page}:${it.y0}`)}
                  hl={pageData?.hl}
                  ink={pageData?.ink}
                  com={pageData?.com}
                  bm={pageData?.bm}
                  sel={selByPage.get(it.page)}
                  search={searchByPage.get(it.page)}
                  flash={flashRects && flashRects.page === it.page ? flashRects.rects : undefined}
                  lasso={lassoSel && lassoSel.page === it.page ? lassoSel : undefined}
                  linkedKeys={linkedKeys}
                  isSelStart={!!sel && orderedSel(sel)[0].page === it.page}
                  isSelEnd={!!sel && orderedSel(sel)[1].page === it.page}
                />
              );
            })}
          {pinchBand && <div className="pinch-band" style={{ top: pinchBand.top + (scrollRef.current?.scrollTop ?? 0), height: pinchBand.bottom - pinchBand.top }} />}
        </div>
      </div>
      {ld && <Overview docId={docId} ld={ld} byPage={byPage} scrollRef={scrollRef} tick={scrollTick} search={searchByPage} pageCount={pageCount} />}
    </div>
  );
}

function orderedSel(sel: TextSel) {
  const { anchor: a, focus: f } = sel;
  return a.page < f.page || (a.page === f.page && a.idx <= f.idx) ? [a, f] : [f, a];
}

export function lastInStack(id: string): string {
  const d = data();
  const ws = d.workspaces.find((w) => w.id === d.activeWs)!;
  let cur = id;
  for (let i = 0; i < 200; i++) {
    const child = ws.items.find((x) => x.dockedTo === cur);
    if (!child) return cur;
    cur = child.id;
  }
  return cur;
}

function FoldBar({ item, width, onOpen }: { item: FoldItem; width: number; onOpen: () => void }) {
  return (
    <div className="fold-bar" style={{ width, marginLeft: MARGIN_L }} onClick={onOpen} title="Tap to expand">
      <span>⋯ {item.to - item.from >= 1 ? `${Math.round(item.to - item.from)} page${Math.round(item.to - item.from) > 1 ? 's' : ''} collapsed` : 'collapsed'} · tap to expand ⋯</span>
    </div>
  );
}

interface SegProps {
  ld: LoadedDoc;
  docId: string;
  seg: Seg;
  s: number;
  pw: number;
  gap: number;
  visible: boolean;
  hl?: Highlight[];
  ink?: DocStroke[];
  com?: Comment[];
  bm?: Bookmark[];
  sel?: Rect[];
  search?: { rects: Rect[]; active: boolean }[];
  flash?: Rect[];
  lasso?: { ids: string[]; rect: Rect; dx: number; dy: number };
  linkedKeys: Set<string>;
  isSelStart: boolean;
  isSelEnd: boolean;
}

const PageSeg = memo(function PageSeg(p: SegProps) {
  const { seg, s, pw } = p;
  const h = seg.y1 - seg.y0;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flashKey = useUI((st) => st.flashKey);

  useEffect(() => {
    if (!p.visible) return;
    let alive = true;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    renderPage(p.ld, seg.page, s * dpr).then((bmp) => {
      const c = canvasRef.current;
      if (!alive || !c) return;
      const q = bmp.width / pw;
      c.width = Math.round(pw * s * dpr);
      c.height = Math.max(1, Math.round(h * s * dpr));
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, seg.y0 * q, bmp.width, h * q, 0, 0, c.width, c.height);
    });
    return () => {
      alive = false;
    };
  }, [p.visible, s, seg.page, seg.y0, seg.y1]);

  const inSeg = (r: Rect) => r[1] + r[3] >= seg.y0 && r[1] <= seg.y1;
  const flashing = (key: string) => flashKey && flashKey.key === key && Date.now() - flashKey.t < 2000;

  // selection handles
  let hs: { x: number; y: number } | null = null;
  let he: { x: number; y: number } | null = null;
  if (p.sel?.length) {
    const f = p.sel[0];
    const l = p.sel[p.sel.length - 1];
    if (p.isSelStart && inSeg(f)) hs = { x: f[0], y: f[1] };
    if (p.isSelEnd && inSeg(l)) he = { x: l[0] + l[2], y: l[1] + l[3] };
  }

  return (
    <div
      className="page-seg"
      data-seg
      data-doc={p.docId}
      data-page={seg.page}
      data-y0={seg.y0}
      data-y1={seg.y1}
      data-key={`${seg.page}:${seg.y0}`}
      style={{ width: pw * s, height: h * s, marginLeft: MARGIN_L, marginBottom: p.gap }}
    >
      <canvas ref={canvasRef} className="page-canvas" style={{ width: pw * s, height: h * s }} />
      {seg.first && <div className="page-label">P {seg.page + 1}</div>}
      <svg className="page-svg" viewBox={`0 ${seg.y0} ${pw} ${h}`} preserveAspectRatio="none" width={pw * s} height={h * s}>
        {p.search?.map((sr, i) => sr.rects.filter(inSeg).map((r, j) => (
          <rect key={`s${i}-${j}`} x={r[0] - 1} y={r[1]} width={r[2] + 2} height={r[3]} rx={2} className={sr.active ? 'search-hit active' : 'search-hit'} />
        )))}
        {p.hl?.map((hl) => (
          <g key={hl.id} data-anchor={'hl:' + hl.id} className={`hl hl-${hl.kind} ${flashing('hl:' + hl.id) ? 'flash' : ''}`}>
            {hl.segments.filter((sg) => sg.page === seg.page).flatMap((sg, k) =>
              sg.rects.filter(inSeg).map((r, j) =>
                hl.kind === 'underline' ? (
                  <rect key={`${k}-${j}`} x={r[0]} y={r[1] + r[3] - 1.6} width={r[2]} height={1.6} fill={hl.color} />
                ) : hl.kind === 'strike' ? (
                  <rect key={`${k}-${j}`} x={r[0]} y={r[1] + r[3] * 0.55} width={r[2]} height={1.2} fill={hl.color} />
                ) : (
                  <rect key={`${k}-${j}`} x={r[0] - 0.5} y={r[1]} width={r[2] + 1} height={r[3]} fill={hl.kind === 'excerpt' ? 'rgba(127,227,224,0.28)' : hl.kind === 'comment' ? 'rgba(255,211,107,0.35)' : hlFill(hl.color)} />
                ),
              ),
            )}
            {hl.kind === 'excerpt' &&
              hl.segments.filter((sg) => sg.page === seg.page).map((sg, k) => {
                const r0 = sg.rects[0];
                const r1 = sg.rects[sg.rects.length - 1];
                if (!r0 || !inSeg(r0)) return null;
                const mx = Math.min(...sg.rects.map((r) => r[0]));
                return <rect key={'m' + k} x={Math.max(2, mx - 12)} y={r0[1]} width={3.5} height={r1[1] + r1[3] - r0[1]} fill="#2bb5b0" rx={1.5} />;
              })}
          </g>
        ))}
        {p.sel?.filter(inSeg).map((r, i) => <rect key={'sel' + i} x={r[0] - 0.5} y={r[1]} width={r[2] + 1} height={r[3]} className="sel-rect" />)}
        {p.flash?.filter(inSeg).map((r, i) => <rect key={'fl' + i} x={r[0] - 2} y={r[1] - 2} width={r[2] + 4} height={r[3] + 4} className="flash-rect" rx={3} />)}
        {p.ink?.map((st) => {
          const moving = p.lasso?.ids.includes(st.id);
          return (
            <path
              key={st.id}
              data-anchor={'docink:' + st.id}
              d={strokeOutline(st.points, st.width, st.kind)}
              transform={moving ? `translate(${p.lasso!.dx},${p.lasso!.dy})` : undefined}
              {...(st.kind === 'highlighter'
                ? { fill: 'none', stroke: st.color, strokeWidth: st.width, strokeOpacity: 0.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
                : { fill: st.color })}
              className={moving ? 'ink-selected' : undefined}
            />
          );
        })}
        {p.lasso && (
          <rect
            x={p.lasso.rect[0] + p.lasso.dx - 4}
            y={p.lasso.rect[1] + p.lasso.dy - 4}
            width={p.lasso.rect[2] + 8}
            height={p.lasso.rect[3] + 8}
            className="lasso-box"
          />
        )}
      </svg>
      {/* comment markers */}
      {p.com?.filter((c) => c.y >= seg.y0 - 2 && c.y <= seg.y1).map((c) => (
        <div
          key={c.id}
          data-comment-marker
          data-anchor={'comment:' + c.id}
          className={`comment-marker no-doc-gesture ${flashing('comment:' + c.id) ? 'flash' : ''}`}
          style={{ left: Math.min(pw - 8, c.x + 2) * s, top: (c.y - seg.y0) * s - 6 }}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setUI({ popover: { kind: 'comment', id: c.id, x: r.right, y: r.top } });
          }}
        >
          <svg viewBox="0 0 20 20" width="18" height="18"><path d="M3 3h14v10H8l-4 4v-4H3z" fill="#ffd36b" stroke="#a87b00" strokeWidth="1.2" /></svg>
          {c.text && <span className="comment-preview">{c.text.slice(0, 60)}</span>}
        </div>
      ))}
      {/* bookmarks */}
      {p.bm?.filter((b) => b.y >= seg.y0 && b.y <= seg.y1).map((b) => (
        <div key={b.id} data-bm-marker className="bm-marker no-doc-gesture" style={{ top: (b.y - seg.y0) * s }} title={b.name}>
          <svg viewBox="0 0 12 16" width="12" height="16"><path d="M0 0h12v16l-6-4-6 4z" fill="#e0533d" /></svg>
        </div>
      ))}
      {/* link badges on highlights */}
      {p.hl?.filter((hl) => p.linkedKeys.has('hl:' + hl.id)).map((hl) => {
        const sg = hl.segments.find((x) => x.page === seg.page);
        const r = sg?.rects[sg.rects.length - 1];
        if (!r || !inSeg(r)) return null;
        return (
          <div
            key={'lb' + hl.id}
            data-link-badge
            className="link-badge no-doc-gesture"
            style={{ left: (r[0] + r[2]) * s + 2, top: (r[1] - seg.y0) * s - 6 }}
            onClick={() => {
              const ls = linksFor('hl:' + hl.id);
              const l = ls[0];
              if (l) goToAnchor(anchorKey(l.a) === 'hl:' + hl.id ? l.b : l.a);
            }}
          >
            ↗
          </div>
        );
      })}
      {hs && (
        <div data-handle="start" className="sel-handle start" style={{ left: hs.x * s - 9, top: (hs.y - seg.y0) * s - 10 }}>
          <i />
        </div>
      )}
      {he && (
        <div data-handle="end" className="sel-handle end" style={{ left: he.x * s - 9, top: (he.y - seg.y0) * s - 16 }}>
          <i />
        </div>
      )}
    </div>
  );
});

/** Left-hand miniature map of the whole document with annotation ticks; tap/drag to navigate */
function Overview({ docId, ld, byPage, scrollRef, tick, search, pageCount }: {
  docId: string;
  ld: LoadedDoc;
  byPage: Map<number, { hl: Highlight[]; ink: DocStroke[]; com: Comment[] }>;
  scrollRef: React.RefObject<HTMLDivElement>;
  tick: number;
  search: Map<number, { rects: Rect[]; active: boolean }[]>;
  pageCount: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hgt, setHgt] = useState(400);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHgt(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ticks: { y: number; color: string; w: number }[] = [];
  const toY = (page: number, y: number) => ((page + y / ld.pages[page].height) / pageCount) * hgt;
  byPage.forEach((v, page) => {
    for (const h of v.hl) for (const sg of h.segments) if (sg.page === page) for (const r of sg.rects) ticks.push({ y: toY(page, r[1]), color: h.kind === 'excerpt' ? '#2bb5b0' : h.kind === 'comment' ? '#f0b400' : h.color, w: 10 });
    for (const st of v.ink) ticks.push({ y: toY(page, st.points[0]?.[1] ?? 0), color: st.color, w: 6 });
    for (const c of v.com) ticks.push({ y: toY(page, c.y), color: '#f0b400', w: 12 });
  });
  search.forEach((arr, page) => arr.forEach((h) => h.rects[0] && ticks.push({ y: toY(page, h.rects[0][1]), color: '#ff8a00', w: 14 })));
  // viewport indicator
  const sc = scrollRef.current;
  let vTop = 0,
    vH = 20;
  if (sc && sc.scrollHeight > 0) {
    vTop = (sc.scrollTop / sc.scrollHeight) * hgt;
    vH = Math.max(14, (sc.clientHeight / sc.scrollHeight) * hgt);
  }
  void tick;
  const nav = (cy: number) => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (cy - r.top) / r.height));
    const sc2 = scrollRef.current!;
    sc2.scrollTop = f * sc2.scrollHeight - sc2.clientHeight / 2;
  };
  return (
    <div
      ref={ref}
      className="doc-overview no-doc-gesture"
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        nav(e.clientY);
      }}
      onPointerMove={(e) => e.buttons && nav(e.clientY)}
    >
      {Array.from({ length: Math.min(pageCount, 200) }, (_, i) => (
        <div key={i} className="ov-page" style={{ top: (i / pageCount) * hgt }} />
      ))}
      {ticks.map((t, i) => (
        <div key={i} className="ov-tick" style={{ top: t.y, background: t.color, width: t.w }} />
      ))}
      <div className="ov-viewport" style={{ top: vTop, height: vH }} />
    </div>
  );
}

export async function regionText(docId: string, page: number, rect: Rect): Promise<string> {
  const d = data().docs.find((x) => x.id === docId);
  if (!d) return '';
  const ld = await loadDoc(d.fileId);
  const pt = await getPageText(ld, page);
  const idx: number[] = [];
  pt.chars.forEach((c, i) => {
    const cx = c.x + c.w / 2,
      cy = c.y + c.h / 2;
    if (cx >= rect[0] && cx <= rect[0] + rect[2] && cy >= rect[1] && cy <= rect[1] + rect[3]) idx.push(i);
  });
  if (!idx.length) return '';
  return rangeText(pt, idx[0], idx[idx.length - 1] + 1);
}

export async function regionRange(docId: string, page: number, rect: Rect): Promise<TextSel | null> {
  const d = data().docs.find((x) => x.id === docId);
  if (!d) return null;
  const ld = await loadDoc(d.fileId);
  const pt = await getPageText(ld, page);
  let a = -1,
    b = -1;
  pt.chars.forEach((c, i) => {
    const cx = c.x + c.w / 2,
      cy = c.y + c.h / 2;
    if (cx >= rect[0] && cx <= rect[0] + rect[2] && cy >= rect[1] && cy <= rect[1] + rect[3]) {
      if (a < 0) a = i;
      b = i;
    }
  });
  if (a < 0) return null;
  return { docId, anchor: { page, idx: a }, focus: { page, idx: b } };
}

export { cropPage, rangeRects };
export type { Fold };
