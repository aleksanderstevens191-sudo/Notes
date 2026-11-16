// Exporting: annotated PDFs, workspace images/PDFs, notes summary, project backup files
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { db } from './db';
import { useApp, uid } from './store';
import { strokeOutline } from './ink';
import type { ProjectData, ProjectMeta, Workspace } from './types';
import { hlFill } from './types';
import { exportFilename, shareOrDownload, htmlToText } from './actions';

function hexToRgb(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
function rgbaParts(css: string) {
  const m = /rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)/.exec(css.replace(/\s/g, ''));
  if (!m) return { c: hexToRgb(css), a: 0.4 };
  return { c: rgb(+m[1] / 255, +m[2] / 255, +m[3] / 255), a: m[4] ? +m[4] : 1 };
}
function ascii(s: string) {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7e\xa1-\xff\n]/g, '');
}

export async function buildAnnotatedPdf(d: ProjectData, docId: string, withSummary = true): Promise<Uint8Array> {
  const doc = d.docs.find((x) => x.id === docId)!;
  const f = await db.getFile(doc.fileId);
  const pdf = await PDFDocument.load(f!.bytes.slice(0), { ignoreEncryption: true });
  const pages = pdf.getPages();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const h of d.highlights.filter((x) => x.docId === docId)) {
    for (const sg of h.segments) {
      const page = pages[sg.page];
      if (!page) continue;
      const { height } = page.getSize();
      const box = page.getMediaBox();
      for (const r of sg.rects) {
        const y = box.y + height - r[1] - r[3];
        if (h.kind === 'underline') page.drawRectangle({ x: box.x + r[0], y, width: r[2], height: 1.2, color: hexToRgb(h.color) });
        else if (h.kind === 'strike') page.drawRectangle({ x: box.x + r[0], y: y + r[3] * 0.45, width: r[2], height: 1, color: hexToRgb(h.color) });
        else {
          const { c, a } = rgbaParts(h.kind === 'excerpt' ? 'rgba(127,227,224,0.3)' : h.kind === 'comment' ? 'rgba(255,211,107,0.35)' : hlFill(h.color));
          page.drawRectangle({ x: box.x + r[0], y, width: r[2], height: r[3], color: c, opacity: a, blendMode: 'Multiply' as any });
        }
      }
    }
  }
  for (const s of d.docInk.filter((x) => x.docId === docId)) {
    const page = pages[s.page];
    if (!page) continue;
    const { height } = page.getSize();
    const box = page.getMediaBox();
    const path = strokeOutline(s.points, s.width, s.kind);
    if (s.kind === 'highlighter') page.drawSvgPath(path, { x: box.x, y: box.y + height, borderColor: hexToRgb(s.color), borderWidth: s.width, borderOpacity: 0.4, borderLineCap: 1 as any });
    else page.drawSvgPath(path, { x: box.x, y: box.y + height, color: hexToRgb(s.color) });
  }
  const comments = d.comments.filter((c) => c.docId === docId);
  comments.forEach((c, i) => {
    const page = pages[c.page];
    if (!page) return;
    const { height } = page.getSize();
    const box = page.getMediaBox();
    const x = box.x + Math.min(page.getWidth() - 16, c.x + 2);
    const y = box.y + height - c.y - 12;
    page.drawRectangle({ x, y, width: 14, height: 12, color: rgb(1, 0.83, 0.42), borderColor: rgb(0.66, 0.48, 0), borderWidth: 0.6 });
    page.drawText(String(i + 1), { x: x + 3.5, y: y + 2.5, size: 7, font, color: rgb(0.3, 0.2, 0) });
  });
  if (withSummary && (comments.length || d.highlights.some((h) => h.docId === docId))) {
    let page = pdf.addPage([612, 792]);
    let y = 740;
    const line = (t: string, size = 10, color = rgb(0.1, 0.1, 0.1), indent = 0) => {
      const words = ascii(t).split(/\s+/);
      let cur = '';
      const flush = () => {
        if (y < 60) {
          page = pdf.addPage([612, 792]);
          y = 740;
        }
        page.drawText(cur, { x: 56 + indent, y, size, font, color });
        y -= size + 4;
        cur = '';
      };
      for (const w of words) {
        const t2 = cur ? cur + ' ' + w : w;
        if (font.widthOfTextAtSize(t2, size) > 500 - indent && cur) flush(), (cur = w);
        else cur = t2;
      }
      if (cur) flush();
    };
    line('Annotations - ' + doc.name, 16);
    y -= 8;
    if (comments.length) {
      line('Comments', 12, rgb(0.4, 0.3, 0));
      comments.forEach((c, i) => {
        const h = d.highlights.find((x) => x.id === c.hlId);
        line(`${i + 1}. (p.${c.page + 1}) ${c.text || '(empty)'}`, 10);
        if (h) line(`"${h.text}"`, 9, rgb(0.4, 0.4, 0.45), 14);
        y -= 4;
      });
    }
    const hs = d.highlights.filter((h) => h.docId === docId && h.kind !== 'comment').sort((a, b) => (a.segments[0]?.page ?? 0) - (b.segments[0]?.page ?? 0));
    if (hs.length) {
      y -= 6;
      line('Highlights & excerpts', 12, rgb(0.2, 0.3, 0.5));
      for (const h of hs) {
        line(`p.${(h.segments[0]?.page ?? 0) + 1}${h.tags.length ? '  ' + h.tags.map((t) => '#' + t).join(' ') : ''}: "${h.text}"`, 9.5);
        y -= 3;
      }
    }
  }
  return pdf.save();
}

export async function exportAnnotatedPdf(docId: string) {
  const p = useApp.getState().project!;
  const bytes = await buildAnnotatedPdf(p.data, docId);
  const doc = p.data.docs.find((x) => x.id === docId)!;
  await shareOrDownload(new Blob([bytes as BlobPart], { type: 'application/pdf' }), exportFilename(doc.name + ' (annotated)', 'pdf'));
}

export async function exportOriginalPdf(docId: string) {
  const p = useApp.getState().project!;
  const doc = p.data.docs.find((x) => x.id === docId)!;
  const f = await db.getFile(doc.fileId);
  if (f) await shareOrDownload(new Blob([f.bytes], { type: 'application/pdf' }), exportFilename(doc.name, 'pdf'));
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/);
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && cur) {
        out.push(cur);
        cur = w;
      } else cur = t;
    }
    out.push(cur);
  }
  return out;
}

function loadImg(src: string) {
  return new Promise<HTMLImageElement>((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(im);
    im.src = src;
  });
}

/** Render a workspace to a canvas (items, stacks, ink, links). */
export async function renderWorkspace(ws: Workspace, d: ProjectData, scale = 2): Promise<HTMLCanvasElement> {
  // compute layout: stacks under heads
  const pos = new Map<string, { x: number; y: number; h: number }>();
  const measure = document.createElement('canvas').getContext('2d')!;
  const heightOf = (it: Workspace['items'][number]) => {
    if (it.type === 'image') return (it.h ?? 120) + (it.text ? 0 : 0) + 30;
    if (it.type === 'note' && it.h) return it.h;
    const fs = it.fontSize ?? (it.type === 'note' ? 16 : 13);
    measure.font = `${fs}px -apple-system, Helvetica, Arial`;
    const lines = wrapLines(measure, it.type === 'note' ? htmlToText(it.text) : it.text, it.w - 28);
    return lines.length * fs * 1.35 + 24 + (it.source ? 18 : 0);
  };
  const heads = ws.items.filter((i) => !i.dockedTo || !ws.items.some((x) => x.id === i.dockedTo));
  for (const h of heads) {
    let y = h.y;
    let cur: Workspace['items'][number] | undefined = h;
    for (let k = 0; cur && k < 300; k++) {
      const hh = heightOf(cur);
      pos.set(cur.id, { x: h.x, y, h: hh });
      y += hh;
      const id: string = cur.id;
      cur = ws.items.find((x) => x.dockedTo === id);
    }
  }
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const it of ws.items) {
    const p = pos.get(it.id);
    if (!p) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + it.w);
    y1 = Math.max(y1, p.y + p.h);
  }
  for (const s of ws.ink) for (const pt of s.points) {
    x0 = Math.min(x0, pt[0] - s.width);
    y0 = Math.min(y0, pt[1] - s.width);
    x1 = Math.max(x1, pt[0] + s.width);
    y1 = Math.max(y1, pt[1] + s.width);
  }
  if (!isFinite(x0)) {
    x0 = 0;
    y0 = 0;
    x1 = 400;
    y1 = 300;
  }
  const pad = 40;
  const W = x1 - x0 + pad * 2,
    H = y1 - y0 + pad * 2;
  const sc = Math.min(scale, 8000 / Math.max(W, H));
  const c = document.createElement('canvas');
  c.width = Math.ceil(W * sc);
  c.height = Math.ceil(H * sc);
  const ctx = c.getContext('2d')!;
  ctx.scale(sc, sc);
  ctx.translate(pad - x0, pad - y0);
  ctx.fillStyle = '#eef1f5';
  ctx.fillRect(x0 - pad, y0 - pad, W, H);
  // links between workspace items
  for (const l of d.links) {
    if (l.a.kind !== 'item' || l.b.kind !== 'item') continue;
    const a = pos.get(l.a.id),
      b = pos.get(l.b.id);
    const ia = ws.items.find((i) => i.id === (l.a as any).id),
      ib = ws.items.find((i) => i.id === (l.b as any).id);
    if (!a || !b || !ia || !ib) continue;
    ctx.strokeStyle = l.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x + ia.w / 2, a.y + a.h / 2);
    ctx.lineTo(b.x + ib.w / 2, b.y + b.h / 2);
    ctx.stroke();
  }
  for (const it of ws.items) {
    const p = pos.get(it.id);
    if (!p) continue;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#fff';
    ctx.fillRect(p.x, p.y, it.w, p.h - 2);
    ctx.restore();
    ctx.fillStyle = it.color;
    ctx.fillRect(p.x, p.y, 6, p.h - 2);
    if (it.type === 'image' && it.image) {
      const im = await loadImg(it.image);
      ctx.drawImage(im, p.x + 12, p.y + 8, it.w - 20, (it.h ?? 120) - 4);
    } else {
      const fs = it.fontSize ?? (it.type === 'note' ? 16 : 13);
      ctx.font = `${fs}px -apple-system, Helvetica, Arial`;
      ctx.fillStyle = '#222';
      const lines = wrapLines(ctx, it.type === 'note' ? htmlToText(it.text) : it.text, it.w - 28);
      lines.forEach((ln, i) => ctx.fillText(ln, p.x + 16, p.y + 12 + fs + i * fs * 1.35));
    }
    if (it.source) {
      ctx.font = 'italic 11px -apple-system, Helvetica, Arial';
      ctx.fillStyle = '#555';
      ctx.fillText(`-${d.docs.find((x) => x.id === it.source!.docId)?.name ?? 'Document'}, p.${it.source.page + 1}`, p.x + 16, p.y + p.h - 10);
    }
  }
  for (const s of ws.ink) {
    const path = new Path2D(strokeOutline(s.points, s.width, s.kind));
    if (s.kind === 'highlighter') {
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(path);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = s.color;
      ctx.fill(path);
    }
  }
  return c;
}

export async function exportWorkspacePng() {
  const p = useApp.getState().project!;
  const ws = p.data.workspaces.find((w) => w.id === p.data.activeWs)!;
  const c = await renderWorkspace(ws, p.data);
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
  await shareOrDownload(blob, exportFilename(`${p.meta.name} - ${ws.name}`, 'png'));
}

export async function exportWorkspacePdf() {
  const p = useApp.getState().project!;
  const ws = p.data.workspaces.find((w) => w.id === p.data.activeWs)!;
  const c = await renderWorkspace(ws, p.data, 2);
  const pdf = await PDFDocument.create();
  const png = await pdf.embedPng(await (await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))).arrayBuffer());
  const w = c.width / 2,
    h = c.height / 2;
  const page = pdf.addPage([w, h]);
  page.drawImage(png, { x: 0, y: 0, width: w, height: h });
  const bytes = await pdf.save();
  await shareOrDownload(new Blob([bytes as BlobPart], { type: 'application/pdf' }), exportFilename(`${p.meta.name} - ${ws.name}`, 'pdf'));
}

export function notesMarkdown(meta: ProjectMeta, d: ProjectData): string {
  let md = `# ${meta.name}\n\n`;
  for (const ws of d.workspaces) {
    md += `## ${ws.name}\n\n`;
    const heads = ws.items.filter((i) => !i.dockedTo).sort((a, b) => a.y - b.y || a.x - b.x);
    for (const h of heads) {
      let cur: (typeof ws.items)[number] | undefined = h;
      let first = true;
      while (cur) {
        const txt = cur.type === 'note' ? htmlToText(cur.text) : cur.text;
        const src = cur.source ? ` _(${d.docs.find((x) => x.id === cur!.source!.docId)?.name ?? 'Document'}, p.${cur.source.page + 1})_` : '';
        const tags = cur.tags.length ? ' ' + cur.tags.map((t) => '#' + t).join(' ') : '';
        md += `${first ? '- ' : '  - '}${cur.type === 'excerpt' ? '> ' : ''}${txt.replace(/\n/g, ' ')}${src}${tags}\n`;
        first = false;
        const id: string = cur.id;
        cur = ws.items.find((x) => x.dockedTo === id);
      }
    }
    md += '\n';
  }
  for (const doc of d.docs) {
    const hs = d.highlights.filter((h) => h.docId === doc.id && h.kind !== 'excerpt');
    const cs = d.comments.filter((c) => c.docId === doc.id);
    if (!hs.length && !cs.length) continue;
    md += `## ${doc.name}\n\n`;
    for (const h of hs.sort((a, b) => (a.segments[0]?.page ?? 0) - (b.segments[0]?.page ?? 0))) {
      if (h.kind === 'comment') continue;
      md += `- p.${(h.segments[0]?.page ?? 0) + 1}: "${h.text}"${h.tags.length ? ' ' + h.tags.map((t) => '#' + t).join(' ') : ''}\n`;
    }
    for (const c of cs) {
      const h = d.highlights.find((x) => x.id === c.hlId);
      md += `- 💬 p.${c.page + 1}: ${c.text}${h ? ` — on "${h.text}"` : ''}\n`;
    }
    md += '\n';
  }
  return md;
}

export async function exportNotes() {
  const p = useApp.getState().project!;
  const md = notesMarkdown(p.meta, p.data);
  await shareOrDownload(new Blob([md], { type: 'text/markdown' }), exportFilename(p.meta.name + ' notes', 'md'));
}

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  return btoa(s);
}
function unb64(s: string): ArrayBuffer {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function projectFileBlob(id: string): Promise<{ blob: Blob; name: string }> {
  const meta = (await db.getMeta(id))!;
  const data = (await db.getData(id))!;
  const files: Record<string, { name: string; mime: string; b64: string }> = {};
  for (const doc of data.docs) {
    const f = await db.getFile(doc.fileId);
    if (f) files[doc.fileId] = { name: f.name, mime: f.mime, b64: b64(f.bytes) };
  }
  const json = JSON.stringify({ format: 'fluidnotes-project', version: 1, meta, data, files });
  return { blob: new Blob([json], { type: 'application/json' }), name: exportFilename(meta.name, 'fluidnotes') };
}

export async function exportProjectFile(id: string) {
  const { blob, name } = await projectFileBlob(id);
  await shareOrDownload(blob, name);
}

export async function importProjectFile(f: File): Promise<string> {
  const j = JSON.parse(await f.text());
  if (j.format !== 'fluidnotes-project') throw new Error('Not a FluidNotes project file');
  const data: ProjectData = j.data;
  const idMap: Record<string, string> = {};
  for (const [oldId, file] of Object.entries<any>(j.files || {})) {
    const nid = uid();
    idMap[oldId] = nid;
    await db.putFile(nid, { bytes: unb64(file.b64), mime: file.mime, name: file.name });
  }
  for (const d of data.docs) d.fileId = idMap[d.fileId] ?? d.fileId;
  const id = uid();
  const meta: ProjectMeta = { ...j.meta, id, folderId: useApp.getState().currentFolder, updatedAt: Date.now() };
  await db.putData(id, data);
  await db.putMeta(meta);
  await useApp.getState().refreshLibrary();
  return id;
}

export async function printDoc(docId: string) {
  const p = useApp.getState().project!;
  const bytes = await buildAnnotatedPdf(p.data, docId, false);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const w = window.open(url, '_blank');
  if (!w) await shareOrDownload(new Blob([bytes as BlobPart], { type: 'application/pdf' }), 'print.pdf');
}

/** Small thumbnail used on the library shelf: first page + workspace sketch */
export async function makeThumb(d: ProjectData): Promise<string | undefined> {
  try {
    const c = document.createElement('canvas');
    c.width = 340;
    c.height = 236;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#e4e8ee';
    ctx.fillRect(0, 0, c.width, c.height);
    const doc = d.docs[0];
    if (doc) {
      const { loadDoc, renderPage } = await import('./pdf');
      const ld = await loadDoc(doc.fileId);
      const bmp = await renderPage(ld, 0, 0.5);
      const h = 210;
      const w = (bmp.width / bmp.height) * h;
      ctx.fillStyle = '#fff';
      for (let k = 2; k >= 1; k--) {
        ctx.fillStyle = '#f7f7f7';
        ctx.fillRect(18 + k * 4, 12 + k * 4, w, h);
      }
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.2)';
      ctx.shadowBlur = 6;
      ctx.drawImage(bmp, 18, 12, w, h);
      ctx.restore();
    }
    const ws = d.workspaces.find((x) => x.id === d.activeWs) ?? d.workspaces[0];
    if (ws && (ws.items.length || ws.ink.length)) {
      const wc = await renderWorkspace(ws, d, 0.5);
      const box = { x: 190, y: 14, w: 140, h: 208 };
      const k = Math.min(box.w / wc.width, box.h / wc.height);
      ctx.drawImage(wc, box.x + (box.w - wc.width * k) / 2, box.y, wc.width * k, wc.height * k);
    }
    return c.toDataURL('image/jpeg', 0.8);
  } catch (e) {
    console.warn('thumb failed', e);
    return undefined;
  }
}
