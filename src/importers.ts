// Converting imported content (PDFs, images, text, web pages) into PDF documents
import { PDFDocument, StandardFonts, rgb, PDFFont } from 'pdf-lib';

export async function fileToArrayBuffer(f: Blob): Promise<ArrayBuffer> {
  return await f.arrayBuffer();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('Could not decode image'));
    im.src = src;
  });
}

/** Convert one or more image files into a PDF (one page per image). */
export async function imagesToPdf(files: Blob[]): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create();
  for (const f of files) {
    const url = URL.createObjectURL(f);
    try {
      const im = await loadImage(url);
      const max = 2600;
      const s = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * s);
      c.height = Math.round(im.naturalHeight * s);
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(im, 0, 0, c.width, c.height);
      const jpg = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.9));
      const img = await pdf.embedJpg(await jpg.arrayBuffer());
      // fit to page width 612pt keeping aspect
      const pw = 612;
      const ph = (c.height / c.width) * pw;
      const page = pdf.addPage([pw, ph]);
      page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const out = await pdf.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

function winAnsi(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x09\x0a\x0d\x20-\x7e\xa1-\xff•]/g, '');
}

interface Block {
  text: string;
  kind: 'h1' | 'h2' | 'h3' | 'p' | 'li' | 'quote';
}

function wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (font.widthOfTextAtSize(t, size) > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Lay out structured text blocks into a clean, readable PDF. */
export async function blocksToPdf(title: string, blocks: Block[], subtitle?: string): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create();
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const serifB = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const sansB = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 612;
  const H = 792;
  const M = 64;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const newPage = () => {
    page = pdf.addPage([W, H]);
    y = H - M;
  };
  const draw = (txt: string, font: PDFFont, size: number, lead: number, indent = 0, color = rgb(0.1, 0.1, 0.12)) => {
    for (const ln of wrap(winAnsi(txt), font, size, W - 2 * M - indent)) {
      if (y - lead < M) newPage();
      y -= lead;
      page.drawText(ln, { x: M + indent, y, size, font, color });
    }
  };
  draw(title, serifB, 24, 30);
  if (subtitle) {
    y -= 4;
    draw(subtitle, sans, 10, 14, 0, rgb(0.4, 0.42, 0.46));
  }
  y -= 18;
  for (const b of blocks) {
    if (!b.text.trim()) continue;
    switch (b.kind) {
      case 'h1':
        y -= 10;
        draw(b.text, serifB, 18, 23);
        y -= 4;
        break;
      case 'h2':
        y -= 8;
        draw(b.text, sansB, 13, 18);
        y -= 3;
        break;
      case 'h3':
        y -= 6;
        draw(b.text, sansB, 11.5, 16);
        break;
      case 'li':
        draw('•  ' + b.text, sans, 10.5, 15, 12);
        y -= 2;
        break;
      case 'quote':
        draw(b.text, serif, 11.5, 16, 24, rgb(0.3, 0.3, 0.35));
        y -= 6;
        break;
      default:
        draw(b.text, sans, 10.5, 15.5);
        y -= 8;
    }
  }
  const out = await pdf.save();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export async function textToPdf(title: string, text: string): Promise<ArrayBuffer> {
  const blocks: Block[] = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .map((p) => {
      if (/^#{1}\s/.test(p)) return { kind: 'h1', text: p.replace(/^#+\s*/, '') } as Block;
      if (/^#{2,}\s/.test(p)) return { kind: 'h2', text: p.replace(/^#+\s*/, '') } as Block;
      if (/^[-*•]\s/.test(p)) return { kind: 'li', text: p.replace(/^[-*•]\s*/, '') } as Block;
      return { kind: 'p', text: p } as Block;
    });
  return blocksToPdf(title, blocks);
}

export function htmlToBlocks(html: string): { title: string; blocks: Block[] } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,nav,footer,header,aside,form,svg,iframe').forEach((n) => n.remove());
  const title = doc.querySelector('h1')?.textContent?.trim() || doc.title || 'Web page';
  const root = doc.querySelector('article') || doc.querySelector('main') || doc.body;
  const blocks: Block[] = [];
  root.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,pre').forEach((el) => {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    const tag = el.tagName.toLowerCase();
    const kind: Block['kind'] =
      tag === 'h1' ? 'h1' : tag === 'h2' ? 'h2' : tag === 'h3' || tag === 'h4' ? 'h3' : tag === 'li' ? 'li' : tag === 'blockquote' ? 'quote' : 'p';
    if (kind === 'h1' && t === title && !blocks.length) return;
    blocks.push({ kind, text: t });
  });
  if (!blocks.length) {
    const t = (root.textContent || '').replace(/\s+/g, ' ').trim();
    blocks.push({ kind: 'p', text: t });
  }
  return { title, blocks };
}

/** Try to fetch a web page (works for CORS-enabled sites); returns a PDF. */
export async function webpageToPdf(url: string): Promise<{ name: string; bytes: ArrayBuffer }> {
  let html: string | null = null;
  const attempts = [url, `https://r.jina.ai/${url}`];
  let lastErr: unknown = null;
  for (const u of attempts) {
    try {
      const r = await fetch(u, { mode: 'cors' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('pdf')) {
        return { name: url.split('/').pop() || 'Document', bytes: await r.arrayBuffer() };
      }
      html = await r.text();
      if (u !== url) {
        // reader proxy returns markdown-ish text
        const titleM = /^Title:\s*(.+)$/m.exec(html);
        const body = html.split(/Markdown Content:\s*/)[1] || html;
        const bytes = await textToPdf(titleM?.[1] || url, body.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
        return { name: titleM?.[1] || url, bytes };
      }
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (html == null) throw lastErr || new Error('Could not load page');
  const { title, blocks } = htmlToBlocks(html);
  const bytes = await blocksToPdf(title, blocks, url);
  return { name: title, bytes };
}

export function pickFiles(accept: string, multiple = true, capture?: string): Promise<File[]> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.multiple = multiple;
    if (capture) inp.setAttribute('capture', capture);
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.onchange = () => {
      resolve(Array.from(inp.files || []));
      inp.remove();
    };
    // Safari: if cancelled, nothing fires; clean up later
    setTimeout(() => inp.remove(), 120000);
    inp.click();
  });
}

/** Normalise any supported file into PDF bytes */
export async function anyFileToPdf(f: File): Promise<{ name: string; bytes: ArrayBuffer }> {
  const base = f.name.replace(/\.[^.]+$/, '');
  if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) return { name: base, bytes: await f.arrayBuffer() };
  if (f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|gif|webp)$/i.test(f.name)) return { name: base, bytes: await imagesToPdf([f]) };
  if (/\.(html?|xhtml)$/i.test(f.name) || f.type === 'text/html') {
    const { title, blocks } = htmlToBlocks(await f.text());
    return { name: title || base, bytes: await blocksToPdf(title || base, blocks) };
  }
  if (/\.docx$/i.test(f.name)) {
    const txt = await docxToText(f);
    return { name: base, bytes: await textToPdf(base, txt) };
  }
  // plain text / markdown / anything else readable as text
  return { name: base, bytes: await textToPdf(base, await f.text()) };
}

/** Extremely small .docx text extractor (reads word/document.xml from the zip). */
async function docxToText(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer());
  // locate central directory entries
  const dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a valid .docx');
  const cdOff = dv.getUint32(eocd + 16, true);
  const n = dv.getUint16(eocd + 10, true);
  let p = cdOff;
  for (let k = 0; k < n; k++) {
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.slice(p + 46, p + 46 + nlen));
    if (name === 'word/document.xml') {
      const lnlen = dv.getUint16(lho + 26, true);
      const lelen = dv.getUint16(lho + 28, true);
      const data = buf.slice(lho + 30 + lnlen + lelen, lho + 30 + lnlen + lelen + csize);
      let xml: string;
      if (method === 0) xml = new TextDecoder().decode(data);
      else {
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([data]).stream().pipeThrough(ds);
        xml = await new Response(stream).text();
      }
      return xml
        .replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (m) => m.replace(/<w:t[^>]*>([^<]*)<\/w:t>/g, '\u0001$1\u0002').replace(/<[^>]+>/g, '').replace(/\u0001|\u0002/g, '') + '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error('No document text found');
}
