// OCR for scanned documents / photos. Tesseract.js is loaded on demand from a CDN, then the
// recognised words are written back into the PDF as an invisible text layer so that selection,
// highlighting, excerpts and search all work exactly like a normal PDF.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { db } from './db';
import { useApp, uid } from './store';
import { data, edit } from './actions';
import { loadDoc, renderPage, getPageText } from './pdf';

const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js';

export async function docNeedsOcr(docId: string): Promise<boolean> {
  const doc = data().docs.find((d) => d.id === docId);
  if (!doc) return false;
  const ld = await loadDoc(doc.fileId);
  let chars = 0;
  for (let i = 0; i < Math.min(ld.pages.length, 3); i++) chars += (await getPageText(ld, i)).chars.length;
  return chars < 20;
}

export async function ocrDocument(docId: string, onProgress: (msg: string) => void, lang = 'eng') {
  const doc = data().docs.find((d) => d.id === docId)!;
  onProgress('Loading text recognition…');
  const T: any = await import(/* @vite-ignore */ TESS);
  const createWorker = T.createWorker || T.default?.createWorker;
  const worker = await createWorker(lang);
  try {
    const ld = await loadDoc(doc.fileId);
    const f = await db.getFile(doc.fileId);
    const pdf = await PDFDocument.load(f!.bytes.slice(0), { ignoreEncryption: true });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const pages = pdf.getPages();
    for (let i = 0; i < ld.pages.length; i++) {
      onProgress(`Recognizing page ${i + 1} of ${ld.pages.length}…`);
      const existing = await getPageText(ld, i);
      if (existing.chars.length > 40) continue; // already has text
      const scale = 2.5;
      const canvas = await renderPage(ld, i, scale);
      const { data: res } = await worker.recognize(canvas);
      const page = pages[i];
      const { height } = page.getSize();
      const box = page.getMediaBox();
      const q = canvas.width / ld.pages[i].width;
      for (const w of res.words || []) {
        const text = String(w.text || '').replace(/[^\x20-\x7e\xa1-\xff]/g, '');
        if (!text.trim() || w.confidence < 30) continue;
        const x0 = w.bbox.x0 / q,
          y0 = w.bbox.y0 / q,
          x1 = w.bbox.x1 / q,
          y1 = w.bbox.y1 / q;
        const bw = x1 - x0,
          bh = y1 - y0;
        const unit = font.widthOfTextAtSize(text, 1) || 1;
        const size = Math.max(bh * 0.6, Math.min(bh * 1.4, bw / unit));
        page.drawText(text, { x: box.x + x0, y: box.y + height - y1 + bh * 0.15, size, font, opacity: 0 });
      }
    }
    onProgress('Saving…');
    const bytes = await pdf.save();
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const fileId = uid();
    await db.putFile(fileId, { bytes: buf, mime: 'application/pdf', name: doc.name });
    edit((d) => {
      const dr = d.docs.find((x) => x.id === docId);
      if (dr) dr.fileId = fileId;
    });
    await useApp.getState().save();
  } finally {
    await worker.terminate();
  }
}
