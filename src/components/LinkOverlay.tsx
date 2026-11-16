import { useEffect, useRef } from 'react';
import { useApp } from '../store';
import { anchorKey } from '../ui';

// Draws every link (doc <-> workspace, card <-> card, ink <-> text…) as a curve in screen space.
// Geometry is recomputed every animation frame so links follow scrolling / panning live.

let lastGeom: { id: string; x1: number; y1: number; x2: number; y2: number }[] = [];

export function linkAtPoint(x: number, y: number, tol = 10): string | null {
  for (const g of lastGeom) {
    const dx = g.x2 - g.x1,
      dy = g.y2 - g.y1;
    const l = dx * dx + dy * dy;
    let t = l ? ((x - g.x1) * dx + (y - g.y1) * dy) / l : 0;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(x - (g.x1 + t * dx), y - (g.y1 + t * dy)) < tol) return g.id;
  }
  return null;
}

function clampToPane(el: Element, x: number, y: number) {
  const pane = el.closest('.doc-scroll, .ws-pane');
  if (!pane) return { x, y, clipped: false };
  const r = pane.getBoundingClientRect();
  const cx = Math.max(r.left + 4, Math.min(r.right - 4, x));
  const cy = Math.max(r.top + 4, Math.min(r.bottom - 4, y));
  return { x: cx, y: cy, clipped: cx !== x || cy !== y };
}

export function LinkOverlay() {
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const svg = svgRef.current;
      const p = useApp.getState().project;
      if (!svg || !p) return;
      const sr = svg.getBoundingClientRect();
      const geom: typeof lastGeom = [];
      let html = '';
      for (const l of p.data.links) {
        const ea = document.querySelector(`[data-anchor="${anchorKey(l.a)}"]`);
        const eb = document.querySelector(`[data-anchor="${anchorKey(l.b)}"]`);
        const pa = ea ? centerOf(ea) : l.a.kind === 'docpos' ? docPosPoint(l.a) : null;
        const pb = eb ? centerOf(eb) : l.b.kind === 'docpos' ? docPosPoint(l.b) : null;
        if (!pa || !pb) continue;
        let a = ea ? clampToPane(ea, pa.x, pa.y) : { ...pa, clipped: false };
        let b = eb ? clampToPane(eb, pb.x, pb.y) : { ...pb, clipped: false };
        // attach to rect edges for nicer look
        if (ea && !a.clipped) a = { ...edgePoint(ea.getBoundingClientRect(), pb), clipped: false };
        if (eb && !b.clipped) b = { ...edgePoint(eb.getBoundingClientRect(), pa), clipped: false };
        const x1 = a.x - sr.left,
          y1 = a.y - sr.top,
          x2 = b.x - sr.left,
          y2 = b.y - sr.top;
        geom.push({ id: l.id, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        const mx = (x1 + x2) / 2;
        const dash = a.clipped || b.clipped ? ' stroke-dasharray="5 5"' : '';
        html += `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" stroke="${l.color}" stroke-width="2" fill="none" stroke-linecap="round" opacity="0.75"${dash}/>`;
        html += `<circle cx="${x1}" cy="${y1}" r="3.5" fill="${l.color}"/><circle cx="${x2}" cy="${y2}" r="3.5" fill="${l.color}"/>`;
      }
      lastGeom = geom;
      if (svg.dataset.html !== html) {
        svg.innerHTML = html;
        svg.dataset.html = html;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <svg ref={svgRef} className="link-overlay" />;
}

function centerOf(el: Element) {
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function edgePoint(r: DOMRect, toward: { x: number; y: number }) {
  const cx = r.left + r.width / 2,
    cy = r.top + r.height / 2;
  const dx = toward.x - cx,
    dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx ? r.width / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? r.height / 2 / Math.abs(dy) : Infinity;
  const k = Math.min(sx, sy, 1);
  return { x: cx + dx * k, y: cy + dy * k };
}

function docPosPoint(a: { docId: string; page: number; x: number; y: number }) {
  const segs = document.querySelectorAll<HTMLElement>(`[data-seg][data-doc="${a.docId}"][data-page="${a.page}"]`);
  for (const el of Array.from(segs)) {
    const y0 = Number(el.dataset.y0),
      y1 = Number(el.dataset.y1);
    if (a.y < y0 || a.y > y1) continue;
    const r = el.getBoundingClientRect();
    const svg = el.querySelector('svg');
    const pw = svg?.viewBox.baseVal.width || r.width;
    const s = r.width / pw;
    const p = { x: r.left + a.x * s, y: r.top + (a.y - y0) * s };
    return clampToPane(el, p.x, p.y);
  }
  return null;
}
