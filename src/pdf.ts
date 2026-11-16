// PDF loading, rendering and text model (character boxes) built on pdf.js
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Rect } from './types';
import { db } from './db';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface CharBox {
  c: string;
  x: number;
  y: number;
  w: number;
  h: number;
  line: number;
}

export interface PageText {
  chars: CharBox[];
  text: string; // same length as chars
  lines: { y: number; h: number; start: number; end: number; x0: number; x1: number }[];
}

export interface PageInfo {
  width: number;
  height: number;
}

export interface LoadedDoc {
  fileId: string;
  pdf: PDFDocumentProxy;
  pages: PageInfo[];
  text: Map<number, Promise<PageText>>;
  textReady: Map<number, PageText>;
  pageProxies: Map<number, Promise<PDFPageProxy>>;
}

const cache = new Map<string, Promise<LoadedDoc>>();
export const loadedSync = new Map<string, LoadedDoc>();

export function loadDoc(fileId: string): Promise<LoadedDoc> {
  let p = cache.get(fileId);
  if (p) return p;
  p = (async () => {
    const f = await db.getFile(fileId);
    if (!f) throw new Error('File missing: ' + fileId);
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(f.bytes.slice(0)), isEvalSupported: false }).promise;
    const pages: PageInfo[] = [];
    const pageProxies = new Map<number, Promise<PDFPageProxy>>();
    for (let i = 0; i < pdf.numPages; i++) {
      const pp = pdf.getPage(i + 1);
      pageProxies.set(i, pp);
      const page = await pp;
      const vp = page.getViewport({ scale: 1 });
      pages.push({ width: vp.width, height: vp.height });
    }
    return { fileId, pdf, pages, text: new Map(), textReady: new Map(), pageProxies };
  })();
  cache.set(fileId, p);
  p.then((d) => loadedSync.set(fileId, d));
  p.catch(() => cache.delete(fileId));
  return p;
}

export function getPage(doc: LoadedDoc, i: number) {
  return doc.pageProxies.get(i)!;
}

const measureCtx = (() => {
  try {
    return document.createElement('canvas').getContext('2d');
  } catch {
    return null;
  }
})();

export function getPageText(doc: LoadedDoc, i: number): Promise<PageText> {
  let p = doc.text.get(i);
  if (p) return p;
  p = (async () => {
    const page = await getPage(doc, i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const raw: { str: string; x: number; y: number; w: number; h: number; font: string }[] = [];
    for (const it of tc.items as any[]) {
      if (!it.str) continue;
      const tx = pdfjs.Util.transform(vp.transform, it.transform);
      const fontH = Math.hypot(tx[2], tx[3]);
      const x = tx[4];
      const yBase = tx[5];
      const w = it.width * (vp.scale || 1);
      const style = (tc.styles as any)[it.fontName];
      const fam = style?.fontFamily || 'sans-serif';
      // vertical text not supported - skip rotated
      if (Math.abs(tx[1]) > Math.abs(tx[0]) * 2) continue;
      raw.push({ str: it.str, x, y: yBase - fontH * 0.85, w, h: fontH * 1.05, font: fam });
    }
    // sort into reading order: group by lines
    raw.sort((a, b) => (Math.abs(a.y - b.y) < Math.min(a.h, b.h) * 0.5 ? a.x - b.x : a.y - b.y));
    const chars: CharBox[] = [];
    const lines: PageText['lines'] = [];
    let line = -1;
    let lastY = -1e9;
    let lastH = 0;
    let lastX1 = 0;
    for (const r of raw) {
      const sameLine = line >= 0 && Math.abs(r.y - lastY) < Math.min(r.h, lastH) * 0.5;
      if (!sameLine) {
        if (line >= 0) {
          // newline separator (zero width) at end of previous line
          const prev = chars[chars.length - 1];
          chars.push({ c: '\n', x: prev.x + prev.w, y: prev.y, w: 0, h: prev.h, line });
          lines[line].end = chars.length;
        }
        line++;
        lines.push({ y: r.y, h: r.h, start: chars.length, end: chars.length, x0: r.x, x1: r.x + r.w });
        lastY = r.y;
        lastH = r.h;
      } else {
        const gap = r.x - lastX1;
        const last = chars[chars.length - 1];
        if (gap > r.h * 0.15 && last && last.c !== ' ' && r.str[0] !== ' ') {
          chars.push({ c: ' ', x: lastX1, y: r.y, w: gap, h: r.h, line });
        }
      }
      // per-char widths using canvas measurement, scaled to the item width
      const s = r.str;
      let widths: number[];
      if (measureCtx) {
        measureCtx.font = `100px ${r.font}`;
        widths = Array.from(s).map((ch) => measureCtx.measureText(ch).width || 50);
      } else widths = Array.from(s).map(() => 1);
      const total = widths.reduce((a, b) => a + b, 0) || 1;
      let cx = r.x;
      const arr = Array.from(s);
      for (let k = 0; k < arr.length; k++) {
        const cw = (widths[k] / total) * r.w;
        chars.push({ c: arr[k], x: cx, y: r.y, w: cw, h: r.h, line });
        cx += cw;
      }
      lastX1 = r.x + r.w;
      const L = lines[line];
      L.x0 = Math.min(L.x0, r.x);
      L.x1 = Math.max(L.x1, r.x + r.w);
      L.y = Math.min(L.y, r.y);
      L.h = Math.max(L.h, r.h);
      L.end = chars.length;
    }
    if (line >= 0) lines[line].end = chars.length;
    const res: PageText = { chars, text: chars.map((c) => c.c).join(''), lines };
    doc.textReady.set(i, res);
    return res;
  })();
  doc.text.set(i, p);
  return p;
}

/** Find char index nearest to a point (page coords). */
export function hitChar(pt: PageText, x: number, y: number): number {
  if (!pt.chars.length) return -1;
  // pick line
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < pt.lines.length; i++) {
    const L = pt.lines[i];
    const d = y < L.y ? L.y - y : y > L.y + L.h ? y - (L.y + L.h) : 0;
    const dx = x < L.x0 - 40 ? L.x0 - 40 - x : x > L.x1 + 40 ? x - L.x1 - 40 : 0;
    const dd = d * 3 + dx;
    if (dd < bd) {
      bd = dd;
      best = i;
    }
  }
  const L = pt.lines[best];
  for (let k = L.start; k < L.end; k++) {
    const c = pt.chars[k];
    if (x < c.x + c.w / 2) return k;
  }
  return Math.max(L.start, L.end - 1);
}

export function wordAt(pt: PageText, idx: number): [number, number] {
  const isW = (c: string) => /[\p{L}\p{N}'’_-]/u.test(c);
  if (idx < 0 || idx >= pt.chars.length) return [idx, idx];
  if (!isW(pt.chars[idx].c)) return [idx, idx + 1];
  let a = idx;
  let b = idx;
  while (a > 0 && isW(pt.chars[a - 1].c)) a--;
  while (b < pt.chars.length && isW(pt.chars[b].c)) b++;
  return [a, b];
}

export function sentenceAt(pt: PageText, idx: number): [number, number] {
  let a = idx;
  let b = idx;
  while (a > 0 && !/[.!?]/.test(pt.chars[a - 1].c)) a--;
  while (b < pt.chars.length && !/[.!?]/.test(pt.chars[b].c)) b++;
  b = Math.min(pt.chars.length, b + 1);
  while (a < b && /\s/.test(pt.chars[a].c)) a++;
  return [a, b];
}

/** Merge char boxes of a range into line rects */
export function rangeRects(pt: PageText, start: number, end: number): Rect[] {
  const out: Rect[] = [];
  let cur: Rect | null = null;
  let curLine = -1;
  for (let k = Math.max(0, start); k < Math.min(end, pt.chars.length); k++) {
    const c = pt.chars[k];
    if (c.c === '\n') continue;
    if (cur && c.line === curLine) {
      const x1 = Math.max(cur[0] + cur[2], c.x + c.w);
      const y0 = Math.min(cur[1], c.y);
      const y1 = Math.max(cur[1] + cur[3], c.y + c.h);
      cur[2] = x1 - cur[0];
      cur[1] = y0;
      cur[3] = y1 - y0;
    } else {
      if (cur) out.push(cur);
      cur = [c.x, c.y, c.w, c.h];
      curLine = c.line;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function rangeText(pt: PageText, start: number, end: number): string {
  return pt.text
    .slice(Math.max(0, start), end)
    .replace(/-\n/g, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- rendering ----------
const bitmapCache = new Map<string, Promise<HTMLCanvasElement>>();
const bitmapOrder: string[] = [];
const MAX_BITMAPS = 24;

/** Render a page to a canvas at given pixel scale (cached). */
export function renderPage(doc: LoadedDoc, i: number, scale: number): Promise<HTMLCanvasElement> {
  const q = Math.max(0.25, Math.round(scale * 4) / 4);
  const key = `${doc.fileId}:${i}:${q}`;
  let p = bitmapCache.get(key);
  if (p) return p;
  p = (async () => {
    const page = await getPage(doc, i);
    const vp = page.getViewport({ scale: q });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  })();
  bitmapCache.set(key, p);
  bitmapOrder.push(key);
  while (bitmapOrder.length > MAX_BITMAPS) {
    const k = bitmapOrder.shift()!;
    bitmapCache.delete(k);
  }
  p.catch(() => bitmapCache.delete(key));
  return p;
}

export async function getOutline(doc: LoadedDoc): Promise<{ title: string; page: number; depth: number }[]> {
  const out: { title: string; page: number; depth: number }[] = [];
  try {
    const ol = await doc.pdf.getOutline();
    if (!ol) return out;
    const walk = async (items: any[], depth: number) => {
      for (const it of items) {
        let page = -1;
        try {
          let dest = it.dest;
          if (typeof dest === 'string') dest = await doc.pdf.getDestination(dest);
          if (Array.isArray(dest)) page = await doc.pdf.getPageIndex(dest[0]);
        } catch {
          /* ignore */
        }
        out.push({ title: it.title, page, depth });
        if (it.items?.length) await walk(it.items, depth + 1);
      }
    };
    await walk(ol, 0);
  } catch {
    /* ignore */
  }
  return out;
}

export async function pdfPageCount(bytes: ArrayBuffer): Promise<number> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise;
  const n = pdf.numPages;
  pdf.destroy();
  return n;
}

export async function cropPage(doc: LoadedDoc, i: number, r: Rect, scale = 2): Promise<string> {
  const c = await renderPage(doc, i, scale);
  const q = c.width / doc.pages[i].width;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(r[2] * q));
  out.height = Math.max(1, Math.round(r[3] * q));
  out.getContext('2d')!.drawImage(c, r[0] * q, r[1] * q, r[2] * q, r[3] * q, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}
