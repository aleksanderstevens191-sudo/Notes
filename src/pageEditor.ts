// PDF page editor: delete, reorder, insert, extract pages while keeping annotations attached
import { PDFDocument } from 'pdf-lib';
import { db } from './db';
import { useApp, uid } from './store';
import { data, edit } from './actions';
import { pickFiles, anyFileToPdf } from './importers';

type Slot = { src: 'self'; page: number } | { src: 'blank' } | { src: 'ext'; pdf: PDFDocument; page: number };

async function rebuild(docId: string, slots: Slot[]) {
  const d = data();
  const doc = d.docs.find((x) => x.id === docId)!;
  const f = await db.getFile(doc.fileId);
  if (!f) throw new Error('Document file missing');
  const src = await PDFDocument.load(f.bytes.slice(0), { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const firstSize = src.getPage(0).getSize();
  for (const s of slots) {
    if (s.src === 'blank') out.addPage([firstSize.width, firstSize.height]);
    else if (s.src === 'self') {
      const [pg] = await out.copyPages(src, [s.page]);
      out.addPage(pg);
    } else {
      const [pg] = await out.copyPages(s.pdf, [s.page]);
      out.addPage(pg);
    }
  }
  const bytes = await out.save();
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const fileId = uid();
  await db.putFile(fileId, { bytes: buf, mime: 'application/pdf', name: doc.name });
  // map old page -> new page (first occurrence)
  const map = new Map<number, number>();
  slots.forEach((s, i) => {
    if (s.src === 'self' && !map.has(s.page)) map.set(s.page, i);
  });
  edit((dd) => {
    const dr = dd.docs.find((x) => x.id === docId)!;
    dr.fileId = fileId;
    dr.pageCount = slots.length;
    dd.highlights = dd.highlights.filter((h) => {
      if (h.docId !== docId) return true;
      h.segments = h.segments.filter((sg) => map.has(sg.page)).map((sg) => ({ ...sg, page: map.get(sg.page)! }));
      return h.segments.length > 0 || h.kind === 'excerpt';
    });
    dd.docInk = dd.docInk.filter((s) => s.docId !== docId || map.has(s.page)).map((s) => (s.docId === docId ? { ...s, page: map.get(s.page)! } : s));
    dd.comments = dd.comments.filter((c) => c.docId !== docId || map.has(c.page)).map((c) => (c.docId === docId ? { ...c, page: map.get(c.page)! } : c));
    dd.bookmarks = dd.bookmarks.filter((b) => b.docId !== docId || map.has(b.page)).map((b) => (b.docId === docId ? { ...b, page: map.get(b.page)! } : b));
    for (const ws of dd.workspaces) for (const it of ws.items) if (it.source?.docId === docId) {
      const np = map.get(it.source.page);
      if (np != null) it.source.page = np;
    }
    dd.folds[docId] = [];
  });
  await useApp.getState().save();
}

const identity = (n: number): Slot[] => Array.from({ length: n }, (_, i) => ({ src: 'self', page: i }));

export async function deletePages(docId: string, pages: number[]) {
  const n = data().docs.find((x) => x.id === docId)!.pageCount;
  const slots = identity(n).filter((s) => !pages.includes((s as any).page));
  if (!slots.length) throw new Error('A document needs at least one page');
  await rebuild(docId, slots);
}

export async function movePages(docId: string, pages: number[], delta: -1 | 1) {
  const n = data().docs.find((x) => x.id === docId)!.pageCount;
  const order = Array.from({ length: n }, (_, i) => i);
  const sel = [...pages].sort((a, b) => (delta < 0 ? a - b : b - a));
  for (const p of sel) {
    const i = order.indexOf(p);
    const j = i + delta;
    if (j < 0 || j >= n || sel.includes(order[j])) continue;
    [order[i], order[j]] = [order[j], order[i]];
  }
  await rebuild(docId, order.map((p) => ({ src: 'self', page: p })));
}

export async function insertBlank(docId: string, after: number) {
  const n = data().docs.find((x) => x.id === docId)!.pageCount;
  const slots: Slot[] = identity(n);
  slots.splice(after + 1, 0, { src: 'blank' });
  await rebuild(docId, slots);
}

export async function insertFromFile(docId: string, after: number) {
  const files = await pickFiles('application/pdf,.pdf,image/*,.txt,.md,.docx', true);
  if (!files.length) return;
  const n = data().docs.find((x) => x.id === docId)!.pageCount;
  const slots: Slot[] = identity(n);
  const ins: Slot[] = [];
  for (const f of files) {
    const { bytes } = await anyFileToPdf(f);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    for (let i = 0; i < pdf.getPageCount(); i++) ins.push({ src: 'ext', pdf, page: i });
  }
  slots.splice(after + 1, 0, ...ins);
  await rebuild(docId, slots);
}

export async function extractPages(docId: string, pages: number[]) {
  const d = data();
  const doc = d.docs.find((x) => x.id === docId)!;
  const f = await db.getFile(doc.fileId);
  const src = await PDFDocument.load(f!.bytes.slice(0), { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, [...pages].sort((a, b) => a - b));
  copied.forEach((p) => out.addPage(p));
  const bytes = await out.save();
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return useApp.getState().addDocToProject(`${doc.name} (pages ${pages.map((p) => p + 1).join(', ')})`, buf);
}
