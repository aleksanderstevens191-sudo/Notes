// Screen-space layer used to preview strokes/lasso while the pencil is down (fast, no React)
import { strokeOutline } from './ink';
import type { Pt } from './types';

let svg: SVGSVGElement | null = null;
let path: SVGPathElement | null = null;
let pts: Pt[] = [];
let mode: 'pen' | 'highlighter' | 'lasso' | 'eraser' = 'pen';
let width = 2;
let raf = 0;

export function mountLiveLayer(el: SVGSVGElement | null) {
  svg = el;
}

function ensurePath() {
  if (!svg) return null;
  if (!path) {
    path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.appendChild(path);
  }
  return path;
}

export function liveStart(kind: typeof mode, color: string, w: number) {
  mode = kind;
  width = w;
  pts = [];
  const p = ensurePath();
  if (!p) return;
  p.setAttribute('d', '');
  if (kind === 'pen') {
    p.setAttribute('fill', color);
    p.setAttribute('stroke', 'none');
    p.removeAttribute('stroke-dasharray');
    p.setAttribute('opacity', '1');
  } else if (kind === 'highlighter') {
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', color);
    p.setAttribute('stroke-width', String(w));
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    p.setAttribute('opacity', '0.4');
    p.removeAttribute('stroke-dasharray');
  } else if (kind === 'eraser') {
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'rgba(120,120,120,0.35)');
    p.setAttribute('stroke-width', String(w));
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    p.setAttribute('opacity', '1');
    p.removeAttribute('stroke-dasharray');
  } else {
    p.setAttribute('fill', 'rgba(91,107,255,0.08)');
    p.setAttribute('stroke', '#5b6bff');
    p.setAttribute('stroke-width', '1.5');
    p.setAttribute('stroke-dasharray', '6 5');
    p.setAttribute('opacity', '1');
  }
}

export function liveAdd(x: number, y: number, pressure: number) {
  pts.push([x, y, pressure]);
  if (!raf) raf = requestAnimationFrame(redraw);
}

function redraw() {
  raf = 0;
  if (!path) return;
  if (mode === 'pen') path.setAttribute('d', strokeOutline(pts, width, 'pen', false));
  else if (mode === 'lasso') path.setAttribute('d', pts.length ? 'M' + pts.map((p) => `${p[0]},${p[1]}`).join('L') + 'Z' : '');
  else if (mode === 'eraser') path.setAttribute('d', strokeOutline(pts.slice(-12), width, 'highlighter'));
  else path.setAttribute('d', strokeOutline(pts, width, 'highlighter'));
}

export function liveEnd(): Pt[] {
  const out = pts;
  pts = [];
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (path) path.setAttribute('d', '');
  return out;
}

export function livePoints() {
  return pts;
}
