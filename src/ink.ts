// Ink geometry helpers: smooth pressure-sensitive outlines, hit testing, lasso
import { getStroke } from 'perfect-freehand';
import type { Pt, Stroke, Rect } from './types';

export function strokeOutline(points: Pt[], width: number, kind: 'pen' | 'highlighter', last = true): string {
  if (!points.length) return '';
  if (kind === 'highlighter') {
    // flat marker: polyline path, rendered with stroke
    let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
    for (let i = 1; i < points.length; i++) d += `L${points[i][0].toFixed(1)},${points[i][1].toFixed(1)}`;
    if (points.length === 1) d += `l0.1,0`;
    return d;
  }
  const simulate = points.every((p) => p[2] === 0.5 || p[2] === 0);
  const outline = getStroke(points as unknown as number[][], {
    size: width * 2.2,
    thinning: simulate ? 0.5 : 0.62,
    smoothing: 0.55,
    streamline: 0.35,
    simulatePressure: simulate,
    last,
    start: { taper: 0, cap: true },
    end: { taper: 0, cap: true },
  });
  return svgPathFromOutline(outline);
}

function svgPathFromOutline(pts: number[][]): string {
  const len = pts.length;
  if (len < 4) {
    if (!len) return '';
    const [x, y] = pts[0];
    return `M${x},${y}a1,1 0 1,0 0.1,0Z`;
  }
  const avg = (a: number, b: number) => (a + b) / 2;
  let a = pts[0];
  let b = pts[1];
  const c = pts[2];
  let d = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${avg(b[0], c[0]).toFixed(2)},${avg(b[1], c[1]).toFixed(2)} T`;
  for (let i = 2, max = len - 1; i < max; i++) {
    a = pts[i];
    b = pts[i + 1];
    d += `${avg(a[0], b[0]).toFixed(2)},${avg(a[1], b[1]).toFixed(2)} `;
  }
  return d + 'Z';
}

export function bbox(points: Pt[]): Rect {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of points) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

function distSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax,
    dy = by - ay;
  const l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function strokeHit(s: Stroke, x: number, y: number, r: number): boolean {
  const pts = s.points;
  const rr = r + s.width / 2;
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) < rr;
  for (let i = 1; i < pts.length; i++) {
    if (distSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) < rr) return true;
  }
  return false;
}

/** Split stroke by removing points within radius (pixel eraser). Returns remaining pieces. */
export function eraseFromStroke(s: Stroke, x: number, y: number, r: number): Pt[][] | null {
  const rr = r + s.width / 2;
  let hit = false;
  const pieces: Pt[][] = [];
  let cur: Pt[] = [];
  for (const p of s.points) {
    if (Math.hypot(p[0] - x, p[1] - y) < rr) {
      hit = true;
      if (cur.length) pieces.push(cur);
      cur = [];
    } else cur.push(p);
  }
  if (cur.length) pieces.push(cur);
  return hit ? pieces.filter((p) => p.length > 1) : null;
}

export function pointInPoly(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0],
      yi = poly[i][1],
      xj = poly[j][0],
      yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function strokeInPoly(s: Stroke, poly: [number, number][]): boolean {
  let n = 0;
  for (const p of s.points) if (pointInPoly(p[0], p[1], poly)) n++;
  return n >= s.points.length * 0.6;
}

export function rectInPoly(r: Rect, poly: [number, number][]): boolean {
  const cx = r[0] + r[2] / 2,
    cy = r[1] + r[3] / 2;
  return pointInPoly(cx, cy, poly);
}

export function polyBBox(poly: [number, number][]): Rect {
  return bbox(poly.map((p) => [p[0], p[1], 0] as Pt));
}

/** Simplify near-duplicate points (keeps file sizes small) */
export function simplify(points: Pt[], minDist = 0.6): Pt[] {
  if (points.length < 3) return points;
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const l = out[out.length - 1];
    if (Math.hypot(points[i][0] - l[0], points[i][1] - l[1]) >= minDist) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 100) / 100] as Pt);
}

/** Detect whether a stroke is roughly a straight-ish connector (for ink linking) */
export function isConnectorLike(points: Pt[]): boolean {
  if (points.length < 2) return false;
  const a = points[0],
    b = points[points.length - 1];
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (d < 30) return false;
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return len < d * 2.2;
}
