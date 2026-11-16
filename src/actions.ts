// Shared project operations (highlighting, excerpts, links, navigation, search)
import { useApp, uid } from './store';
import { useUI, ui, setUI, anchorKey, flash, type TextSel, type SearchHit, type WsHit } from './ui';
import { loadDoc, getPageText, rangeRects, rangeText, loadedSync, type LoadedDoc, type PageText } from './pdf';
import type { Anchor, DocRef, Highlight, TextSegment, WsItem, Rect, ProjectData } from './types';

export const data = () => useApp.getState().project!.data;
export const edit = (fn: Parameters<ReturnType<typeof useApp.getState>['edit']>[0], opts?: { coalesce?: string }) =>
  useApp.getState().edit(fn, opts);

export function docById(id: string): DocRef | undefined {
  return data().docs.find((d) => d.id === id);
}

export function loadedFor(docId: string): LoadedDoc | undefined {
  const d = docById(docId);
  return d ? loadedSync.get(d.fileId) : undefined;
}

export async function loadedForAsync(docId: string): Promise<LoadedDoc | undefined> {
  const d = docById(docId);
  return d ? loadDoc(d.fileId) : undefined;
}

export function pageTextSync(docId: string, page: number): PageText | undefined {
  return loadedFor(docId)?.textReady.get(page);
}

function ordered(sel: TextSel) {
  const { anchor: a, focus: f } = sel;
  return a.page < f.page || (a.page === f.page && a.idx <= f.idx) ? [a, f] : [f, a];
}

/** Convert a text selection into per-page segments */
export function selectionSegments(sel: TextSel): { segments: TextSegment[]; text: string } {
  const [a, b] = ordered(sel);
  const segments: TextSegment[] = [];
  const texts: string[] = [];
  for (let p = a.page; p <= b.page; p++) {
    const pt = pageTextSync(sel.docId, p);
    if (!pt) continue;
    const start = p === a.page ? a.idx : 0;
    const end = p === b.page ? b.idx + 1 : pt.chars.length;
    if (end <= start) continue;
    const rects = rangeRects(pt, start, end);
    if (!rects.length) continue;
    segments.push({ page: p, start, end, rects });
    texts.push(rangeText(pt, start, end));
  }
  return { segments, text: texts.join(' ').trim() };
}

export function createHighlight(sel: TextSel, color: string, kind: Highlight['kind'] = 'highlight'): string | null {
  const { segments, text } = selectionSegments(sel);
  if (!segments.length) return null;
  const id = uid();
  edit((d) => {
    d.highlights.push({ id, docId: sel.docId, segments, color, text, tags: [], kind, createdAt: Date.now() });
  });
  return id;
}

export function clearHighlightsInSelection(sel: TextSel) {
  const [a, b] = ordered(sel);
  edit((d) => {
    d.highlights = d.highlights.filter((h) => {
      if (h.docId !== sel.docId || h.kind !== 'highlight') return true;
      return !h.segments.some((s) => {
        const sa = s.page > a.page || (s.page === a.page && s.end > a.idx);
        const sb = s.page < b.page || (s.page === b.page && s.start <= b.idx);
        return sa && sb;
      });
    });
  });
}

export function docLabel(docId: string, page: number) {
  const d = docById(docId);
  return `${d?.name ?? 'Document'}, p.${page + 1}`;
}

/** Place a new excerpt in the active workspace. Returns item id. */
export function createExcerpt(sel: TextSel, at?: { x: number; y: number }, dockTo?: string): string | null {
  const { segments, text } = selectionSegments(sel);
  if (!segments.length) return null;
  const hlId = uid();
  const itemId = uid();
  const pos = at ?? nextFreeSpot();
  edit((d) => {
    d.highlights.push({ id: hlId, docId: sel.docId, segments, color: '#7fe3e0', text, tags: [], kind: 'excerpt', createdAt: Date.now() });
    const ws = d.workspaces.find((w) => w.id === d.activeWs)!;
    ws.items.push({
      id: itemId,
      type: 'excerpt',
      x: pos.x,
      y: pos.y,
      w: 260,
      text,
      color: '#7fe3e0',
      source: { docId: sel.docId, hlId, page: segments[0].page },
      dockedTo: dockTo,
      tags: [],
      createdAt: Date.now(),
    });
  });
  return itemId;
}

export function createExcerptFromHighlight(hlId: string, at?: { x: number; y: number }): string | null {
  const h = data().highlights.find((x) => x.id === hlId);
  if (!h) return null;
  const itemId = uid();
  const pos = at ?? nextFreeSpot();
  edit((d) => {
    const ws = d.workspaces.find((w) => w.id === d.activeWs)!;
    ws.items.push({
      id: itemId,
      type: 'excerpt',
      x: pos.x,
      y: pos.y,
      w: 260,
      text: h.text,
      color: h.color === '#ffe600' ? '#ffe066' : '#7fe3e0',
      source: { docId: h.docId, hlId: h.id, page: h.segments[0]?.page ?? 0 },
      tags: [...h.tags],
      createdAt: Date.now(),
    });
  });
  return itemId;
}

export function createImageExcerpt(docId: string, page: number, rect: Rect, image: string, text: string, at?: { x: number; y: number }) {
  const itemId = uid();
  const pos = at ?? nextFreeSpot();
  const w = Math.min(320, Math.max(120, rect[2]));
  edit((d) => {
    const ws = d.workspaces.find((w) => w.id === d.activeWs)!;
    ws.items.push({
      id: itemId,
      type: 'image',
      x: pos.x,
      y: pos.y,
      w,
      h: (rect[3] / rect[2]) * w,
      text,
      image,
      color: '#c7ceea',
      source: { docId, page, rect },
      tags: [],
      createdAt: Date.now(),
    });
  });
  return itemId;
}

export function activeWs(d: ProjectData = data()) {
  return d.workspaces.find((w) => w.id === d.activeWs) ?? d.workspaces[0];
}

/** Find a free position in the visible part of the workspace for an auto-placed card */
export function nextFreeSpot(): { x: number; y: number } {
  const ws = activeWs();
  const v = ws.view;
  const el = document.querySelector('.ws-pane') as HTMLElement | null;
  const W = el?.clientWidth ?? 600;
  const H = el?.clientHeight ?? 600;
  const pr = el?.getBoundingClientRect();
  // occupied boxes in world coordinates, measured from the DOM (handles stacked cards)
  const boxes: [number, number, number, number][] = [];
  document.querySelectorAll<HTMLElement>('.ws-pane .ws-item').forEach((n) => {
    if (!pr) return;
    const r = n.getBoundingClientRect();
    boxes.push([(r.left - pr.left - v.x) / v.zoom, (r.top - pr.top - v.y) / v.zoom, r.width / v.zoom, r.height / v.zoom]);
  });
  const x0 = (-v.x + 40) / v.zoom;
  const y0 = (-v.y + 60) / v.zoom;
  const cardW = 270;
  const cardH = 110;
  const free = (x: number, y: number) => !boxes.some((b) => x < b[0] + b[2] + 14 && x + cardW > b[0] - 14 && y < b[1] + b[3] + 14 && y + cardH > b[1] - 14);
  const cols = Math.max(1, Math.floor((W / v.zoom - 60) / (cardW + 20)));
  for (let row = 0; row < 60; row++) {
    for (let col = 0; col < cols; col++) {
      const x = x0 + col * (cardW + 20);
      const y = y0 + row * 40;
      if (free(x, y)) return { x, y };
    }
  }
  return { x: x0 + 20, y: y0 + (H / v.zoom) * 0.3 };
}

/** Document position (page coords) under a screen point, if any */
export function docPosAt(cx: number, cy: number): Anchor | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-seg]'))) {
    const r = el.getBoundingClientRect();
    if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
    const svg = el.querySelector('svg');
    const pw = svg?.viewBox.baseVal.width || r.width;
    const s = r.width / pw;
    return { kind: 'docpos', docId: el.dataset.doc!, page: Number(el.dataset.page), x: (cx - r.left) / s, y: Number(el.dataset.y0) + (cy - r.top) / s };
  }
  return null;
}

export function createNote(at?: { x: number; y: number }, text = '', color = '#7fe3e0'): string {
  const id = uid();
  const pos = at ?? nextFreeSpot();
  edit((d) => {
    const ws = d.workspaces.find((w) => w.id === d.activeWs)!;
    ws.items.push({ id, type: 'note', x: pos.x, y: pos.y, w: 240, text, color, fontSize: 16, tags: [], createdAt: Date.now() });
  });
  setUI({ editingItem: id, wsSel: [id] });
  return id;
}

export function addLink(a: Anchor, b: Anchor, color = '#5b6bff') {
  if (anchorKey(a) === anchorKey(b)) return;
  edit((d) => {
    d.links.push({ id: uid(), a, b, color });
  });
}

export function linksFor(key: string, d: ProjectData = data()) {
  return d.links.filter((l) => anchorKey(l.a) === key || anchorKey(l.b) === key);
}

export function anchorFromElement(el: Element | null): Anchor | null {
  const n = el?.closest?.('[data-anchor]') as HTMLElement | null;
  if (!n) return null;
  const key = n.dataset.anchor!;
  const [kind, id] = key.split(':');
  const d = data();
  if (kind === 'item') return { kind: 'item', wsId: d.activeWs, id };
  if (kind === 'hl') return { kind: 'hl', id };
  if (kind === 'comment') return { kind: 'comment', id };
  if (kind === 'wsink') return { kind: 'wsink', wsId: d.activeWs, id };
  if (kind === 'docink') return { kind: 'docink', id };
  return null;
}

export function anchorAtPoint(x: number, y: number, exclude?: Element): Anchor | null {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    if (exclude && exclude.contains(el)) continue;
    const a = anchorFromElement(el);
    if (a) return a;
  }
  return null;
}

// ---------- navigation ----------
export function currentNavEntry(): { docId: string; u: number } | null {
  const docId = ui().openDocs[0];
  if (!docId) return null;
  const el = document.querySelector(`.doc-scroll[data-doc="${docId}"]`) as HTMLElement | null;
  if (!el) return null;
  return { docId, u: Number(el.dataset.u || 0) };
}

export function pushNav() {
  const e = currentNavEntry();
  if (!e) return;
  const nav = ui().nav;
  setUI({ nav: { back: [...nav.back.slice(-50), e], fwd: [] } });
}

export function goToDoc(docId: string, page: number, y: number, flashRects?: Rect[], record = true) {
  if (record) pushNav();
  const open = ui().openDocs;
  if (!open.includes(docId)) setUI({ openDocs: open.length > 1 ? [open[0], docId] : [docId] });
  // unfold collapsed region containing the target
  const folds = data().folds[docId];
  const u = page + y / (loadedFor(docId)?.pages[page]?.height ?? 792);
  if (folds?.some((f) => u >= f.from && u <= f.to)) {
    useApp.getState().editSilent((d) => {
      d.folds[docId] = (d.folds[docId] || []).filter((f) => !(u >= f.from && u <= f.to));
    });
  }
  if (ui().collapsed[docId]) setUI({ collapsed: { ...ui().collapsed, [docId]: false } });
  setTimeout(() => setUI({ scrollReq: { docId, page, y, flash: flashRects, t: Date.now() } }), 30);
}

export function goToHighlight(hlId: string) {
  const h = data().highlights.find((x) => x.id === hlId);
  if (!h || !h.segments.length) return;
  const s = h.segments[0];
  const r = s.rects[0];
  goToDoc(h.docId, s.page, r ? r[1] : 0, h.segments.flatMap((sg) => (sg.page === s.page ? sg.rects : [])));
  setTimeout(() => flash('hl:' + hlId), 300);
}

export function goToItem(itemId: string) {
  const d = data();
  const ws = d.workspaces.find((w) => w.items.some((i) => i.id === itemId));
  if (!ws) return;
  if (ws.id !== d.activeWs) useApp.getState().editSilent((dd) => void (dd.activeWs = ws.id));
  setTimeout(() => {
    setUI({ wsFocusReq: { id: itemId, t: Date.now() }, wsSel: [itemId] });
    flash('item:' + itemId);
  }, 30);
}

export function goToAnchor(a: Anchor) {
  const d = data();
  switch (a.kind) {
    case 'hl':
      return goToHighlight(a.id);
    case 'item':
      return goToItem(a.id);
    case 'comment': {
      const c = d.comments.find((x) => x.id === a.id);
      if (c) goToDoc(c.docId, c.page, c.y);
      setTimeout(() => flash('comment:' + a.id), 300);
      return;
    }
    case 'docpos':
      return goToDoc(a.docId, a.page, a.y);
    case 'docink': {
      const s = d.docInk.find((x) => x.id === a.id);
      if (s) goToDoc(s.docId, s.page, s.points[0]?.[1] ?? 0);
      return;
    }
    case 'wsink': {
      const ws = d.workspaces.find((w) => w.id === a.wsId);
      if (ws && ws.id !== d.activeWs) useApp.getState().editSilent((dd) => void (dd.activeWs = ws.id));
      return;
    }
  }
}

export function goToSource(item: WsItem) {
  if (!item.source) return;
  if (item.source.hlId && data().highlights.some((h) => h.id === item.source!.hlId)) goToHighlight(item.source.hlId);
  else goToDoc(item.source.docId, item.source.page, item.source.rect?.[1] ?? 0, item.source.rect ? [item.source.rect] : undefined);
}

export function navBack() {
  const nav = ui().nav;
  const e = nav.back[nav.back.length - 1];
  if (!e) return;
  const cur = currentNavEntry();
  setUI({ nav: { back: nav.back.slice(0, -1), fwd: cur ? [...nav.fwd, cur] : nav.fwd } });
  scrollToU(e.docId, e.u);
}

export function navForward() {
  const nav = ui().nav;
  const e = nav.fwd[nav.fwd.length - 1];
  if (!e) return;
  const cur = currentNavEntry();
  setUI({ nav: { fwd: nav.fwd.slice(0, -1), back: cur ? [...nav.back, cur] : nav.back } });
  scrollToU(e.docId, e.u);
}

function scrollToU(docId: string, u: number) {
  const page = Math.floor(u);
  const h = loadedFor(docId)?.pages[page]?.height ?? 792;
  if (!ui().openDocs.includes(docId)) setUI({ openDocs: [docId] });
  setTimeout(() => setUI({ scrollReq: { docId, page, y: (u - page) * h, t: Date.now() } }), 30);
}

// ---------- search ----------
export async function runSearch(query: string) {
  const q = query.trim();
  if (!q) {
    setUI({ search: { ...ui().search, query, hits: [], wsHits: [], active: -1 } });
    return;
  }
  const lower = q.toLowerCase();
  const hits: SearchHit[] = [];
  const d = data();
  for (const doc of d.docs) {
    const ld = await loadDoc(doc.fileId);
    for (let p = 0; p < ld.pages.length; p++) {
      const pt = await getPageText(ld, p);
      const norm = pt.text.toLowerCase();
      let i = norm.indexOf(lower);
      while (i >= 0 && hits.length < 2000) {
        const pre = pt.text.slice(Math.max(0, i - 40), i).replace(/\s+/g, ' ');
        const post = pt.text.slice(i + q.length, i + q.length + 60).replace(/\s+/g, ' ');
        hits.push({ docId: doc.id, page: p, start: i, end: i + q.length, snippet: pt.text.slice(i, i + q.length), pre, post });
        i = norm.indexOf(lower, i + q.length);
      }
    }
    if (ui().search.query !== query) return; // superseded
  }
  const wsHits: WsHit[] = [];
  for (const ws of d.workspaces) {
    for (const it of ws.items) {
      const plain = it.type === 'note' ? htmlToText(it.text) : it.text;
      const k = plain.toLowerCase().indexOf(lower);
      if (k >= 0) wsHits.push({ wsId: ws.id, itemId: it.id, snippet: plain.slice(Math.max(0, k - 30), k + 70) });
    }
  }
  for (const c of d.comments) {
    if (c.text.toLowerCase().includes(lower)) wsHits.push({ wsId: '', itemId: 'comment:' + c.id, snippet: c.text.slice(0, 100) });
  }
  setUI({ search: { ...ui().search, query, hits, wsHits, active: hits.length ? 0 : -1 } });
}

export function htmlToText(html: string) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.innerText || div.textContent || '';
}

export function hitRects(h: SearchHit): Rect[] {
  const pt = pageTextSync(h.docId, h.page);
  return pt ? rangeRects(pt, h.start, h.end) : [];
}

export function gotoHit(i: number) {
  const s = ui().search;
  const h = s.hits[i];
  if (!h) return;
  setUI({ search: { ...s, active: i } });
  const rects = hitRects(h);
  goToDoc(h.docId, h.page, rects[0]?.[1] ?? 0, rects, false);
}

export function highlightAllHits(color: string) {
  const hits = ui().search.hits;
  edit((d) => {
    for (const h of hits) {
      const pt = pageTextSync(h.docId, h.page);
      if (!pt) continue;
      d.highlights.push({
        id: uid(),
        docId: h.docId,
        segments: [{ page: h.page, start: h.start, end: h.end, rects: rangeRects(pt, h.start, h.end) }],
        color,
        text: h.snippet,
        tags: [],
        kind: 'highlight',
        createdAt: Date.now(),
      });
    }
  });
  useApp.getState().showToast(`Highlighted ${hits.length} results`);
}

/** Excerpt each search result together with its surrounding sentence, stacked in the workspace */
export function excerptAllHits() {
  const hits = ui().search.hits.slice(0, 60);
  const pos = nextFreeSpot();
  let prev: string | undefined;
  hits.forEach((h, i) => {
    const pt = pageTextSync(h.docId, h.page);
    if (!pt) return;
    let a = h.start;
    let b = h.end;
    while (a > 0 && !/[.!?]/.test(pt.chars[a - 1].c) && h.start - a < 300) a--;
    while (b < pt.chars.length && !/[.!?]/.test(pt.chars[b].c) && b - h.end < 300) b++;
    while (a < b && /\s/.test(pt.chars[a].c)) a++;
    const id = createExcerpt({ docId: h.docId, anchor: { page: h.page, idx: a }, focus: { page: h.page, idx: Math.min(b, pt.chars.length - 1) } }, i === 0 ? pos : pos, prev);
    prev = id ?? prev;
  });
  useApp.getState().showToast(`Excerpted ${hits.length} results`);
}

export function deleteItems(ids: string[]) {
  edit((d) => {
    for (const ws of d.workspaces) {
      const removed = ws.items.filter((i) => ids.includes(i.id));
      // undock children of removed items
      for (const it of ws.items) if (it.dockedTo && ids.includes(it.dockedTo)) {
        const parent = removed.find((r) => r.id === it.dockedTo)!;
        it.dockedTo = parent.dockedTo && !ids.includes(parent.dockedTo) ? parent.dockedTo : undefined;
        if (!it.dockedTo) {
          it.x = parent.x;
          it.y = parent.y;
        }
      }
      ws.items = ws.items.filter((i) => !ids.includes(i.id));
      // remove excerpt source highlights
      for (const r of removed) if (r.source?.hlId) d.highlights = d.highlights.filter((h) => !(h.id === r.source!.hlId && h.kind === 'excerpt'));
    }
    d.links = d.links.filter((l) => !(l.a.kind === 'item' && ids.includes(l.a.id)) && !(l.b.kind === 'item' && ids.includes(l.b.id)));
  });
  setUI({ wsSel: [], popover: null });
}

export function deleteHighlight(id: string) {
  edit((d) => {
    d.highlights = d.highlights.filter((h) => h.id !== id);
    d.links = d.links.filter((l) => !(l.a.kind === 'hl' && l.a.id === id) && !(l.b.kind === 'hl' && l.b.id === id));
    d.comments = d.comments.filter((c) => c.hlId !== id);
  });
  setUI({ popover: null });
}

export function addComment(sel: TextSel | null, hlId?: string): string | null {
  let h = hlId;
  if (!h && sel) h = createHighlight(sel, '#ffd36b', 'comment') ?? undefined;
  const hl = data().highlights.find((x) => x.id === h);
  if (!hl) return null;
  const seg = hl.segments[hl.segments.length - 1];
  const r = seg.rects[seg.rects.length - 1];
  const id = uid();
  edit((d) => {
    d.comments.push({ id, docId: hl.docId, page: seg.page, x: r[0] + r[2], y: r[1], text: '', hlId: hl.id, createdAt: Date.now() });
  }, { coalesce: 'comment-create' });
  return id;
}

export function exportFilename(base: string, ext: string) {
  return base.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) + '.' + ext;
}

export async function shareOrDownload(blob: Blob, filename: string) {
  const file = new File([blob], filename, { type: blob.type });
  const nav = navigator as any;
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: filename });
      return;
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function useOpenDoc() {
  return useUI((s) => s.openDocs[0]);
}

// ---------- deep links (URL links between projects and other apps) ----------
export function deepLink(target: { hl?: string; item?: string }): string {
  const pid = useApp.getState().project!.meta.id;
  const q = new URLSearchParams({ p: pid, ...(target.hl ? { hl: target.hl } : {}), ...(target.item ? { item: target.item } : {}) });
  return `${location.origin}${location.pathname}#${q.toString()}`;
}

export async function copyDeepLink(target: { hl?: string; item?: string }) {
  const url = deepLink(target);
  try {
    await navigator.clipboard.writeText(url);
    useApp.getState().showToast('Link copied — paste it in any app or note');
  } catch {
    prompt('Copy this link', url);
  }
}

export async function openDeepLink(hash: string) {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const pid = q.get('p');
  if (!pid) return;
  const st = useApp.getState();
  if (!st.projects.some((p) => p.id === pid)) {
    st.showToast('That project is not on this device');
    return;
  }
  if (st.project?.meta.id !== pid) await st.openProject(pid);
  const hl = q.get('hl');
  const item = q.get('item');
  setTimeout(() => {
    if (hl) goToHighlight(hl);
    if (item) goToItem(item);
  }, 900);
  history.replaceState(null, '', location.pathname);
}
