// Screen-space layer used to preview strokes/lasso while the pencil is down.
// Low latency: pen/highlighter segments are painted straight onto a canvas inside the pointer
// event handler (no React, no requestAnimationFrame wait, no re-tessellating the whole stroke).
import type { Pt } from './types';

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let pts: Pt[] = [];
let mode: 'pen' | 'highlighter' | 'lasso' | 'eraser' = 'pen';
let width = 2;
let color = '#000';
let dpr = 1;
let lastW = 0;
export let inkActive = false;

function resize() {
  if (!canvas) return;
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = window.innerWidth,
    h = window.innerHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }
}

export function mountLiveLayer(el: HTMLCanvasElement | null) {
  canvas = el;
  if (!el) {
    ctx = null;
    return;
  }
  ctx = (el.getContext('2d', { desynchronized: true, alpha: true } as any) as CanvasRenderingContext2D) || el.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
}

function clear() {
  if (!ctx || !canvas) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/** same width curve as the final stroke renderer, so the line doesn't jump when committed */
function penWidth(p: number) {
  const raw = p > 0 ? Math.min(1, p) : 0.5;
  const mapped = 0.4 + 0.6 * Math.pow(raw, 0.55);
  const target = width * 2.2 * (0.5 - 0.55 * (0.5 - mapped));
  lastW = lastW ? lastW + (target - lastW) * 0.3 : target;
  return lastW;
}

export function liveStart(kind: typeof mode, c: string, w: number) {
  mode = kind;
  width = w;
  color = c;
  pts = [];
  lastW = 0;
  inkActive = true;
  resize();
  clear();
}

export function liveAdd(x: number, y: number, pressure: number) {
  const prev = pts[pts.length - 1];
  pts.push([x, y, pressure]);
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (mode === 'pen') {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = penWidth(pressure);
    ctx.beginPath();
    if (prev) ctx.moveTo(prev[0], prev[1]);
    else ctx.moveTo(x - 0.01, y);
    ctx.lineTo(x, y);
    ctx.stroke();
  } else if (mode === 'highlighter') {
    // redraw as one path so overlapping segments don't darken
    clear();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
  } else if (mode === 'eraser') {
    clear();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(120,120,120,0.35)';
    ctx.lineWidth = width;
    const tail = pts.slice(-10);
    ctx.beginPath();
    ctx.moveTo(tail[0][0], tail[0][1]);
    for (const p of tail) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
  } else {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#5b6bff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    if (prev) {
      ctx.beginPath();
      ctx.moveTo(prev[0], prev[1]);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

export function liveEnd(): Pt[] {
  const out = pts;
  pts = [];
  inkActive = false;
  // keep the live pixels one more frame so the committed SVG stroke appears without a flicker
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!inkActive) clear();
  }));
  return out;
}

export function livePoints() {
  return pts;
}
