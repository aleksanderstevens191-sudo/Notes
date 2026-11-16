// Builds the "Welcome to FluidNotes" sample project shown on first launch
import { blocksToPdf } from './importers';
import { useApp, uid } from './store';
import { db } from './db';
import { loadDoc, getPageText, rangeRects, rangeText } from './pdf';
import type { Highlight, ProjectData, WsItem } from './types';

const P = (text: string) => ({ kind: 'p' as const, text });
const H = (text: string) => ({ kind: 'h2' as const, text });
const L = (text: string) => ({ kind: 'li' as const, text });

export async function createSampleProject() {
  const bytes = await blocksToPdf(
    'Active Reading: Working With Ideas, Not Just Pages',
    [
      H('Introduction'),
      P('Reading for work or study is rarely a straight line. Active reading frequently involves searching, highlighting, comparison, non-sequential navigation, and the like. Readers jump between sections, gather fragments, and build their own structure on top of the text.'),
      P('Paper supports some of this well: it is easy to mark up and to flip between pages. But paper makes it hard to bring distant passages side by side, to keep many excerpts organised, or to connect a note to exactly the sentence that inspired it.'),
      H('Excerpts'),
      P('An excerpt is a piece of a document pulled out into a workspace while staying connected to its source. Excerpts let you regroup ideas by theme instead of by page number, and they always remember where they came from.'),
      P('Try it now: select a sentence on this page with the Apple Pencil, then drag it into the workspace on the right. Tap the small arrow on the card to jump back to the source.'),
      H('Collapsing the document'),
      P('Sometimes the important ideas are pages apart. Pinch the document vertically with two fingers to collapse the text in between, bringing the two passages together on screen. Tap the fold to expand it again. The collapse button in the left rail hides everything except your annotations.'),
      H('Ink and links'),
      P('Write anywhere: in the margins, over the text, or across the workspace. Ink responds to Apple Pencil pressure. Draw a line from a highlight to a note to link them; tapping either end will take you to the other.'),
      L('Comments attach to specific words and can be moved into the workspace.'),
      L('Tags group related highlights and excerpts across documents.'),
      L('Search finds every occurrence across all documents and lets you highlight or excerpt them all at once.'),
      H('Multiple documents'),
      P('A project can hold several documents: PDFs, Word files, web pages, photos and scans. Open two of them side by side to compare, and keep all of your excerpts in one or more shared workspaces.'),
      H('Conclusion'),
      P('Our goal is a reading environment that is better than paper for active reading: as fluid as handwriting, but with the flexibility of software. Highlight, excerpt, collapse, ink and link until the structure of your thinking is visible on the page.'),
    ],
    'A sample document for trying FluidNotes',
  );
  const id = await useApp.getState().createProject('Welcome to FluidNotes', [{ name: 'Active reading guide', bytes }], null);
  // decorate with highlights, excerpts and a note
  const data = (await db.getData(id)) as ProjectData;
  const doc = data.docs[0];
  try {
    const ld = await loadDoc(doc.fileId);
    const find = async (needle: string) => {
      for (let p = 0; p < ld.pages.length; p++) {
        const pt = await getPageText(ld, p);
        const norm = pt.text.replace(/\n/g, ' ');
        const i = norm.indexOf(needle);
        if (i >= 0) return { page: p, start: i, end: i + needle.length, rects: rangeRects(pt, i, i + needle.length), text: rangeText(pt, i, i + needle.length) };
      }
      return null;
    };
    const mk = (seg: NonNullable<Awaited<ReturnType<typeof find>>>, color: string, kind: Highlight['kind']): Highlight => ({
      id: uid(),
      docId: doc.id,
      segments: [{ page: seg.page, start: seg.start, end: seg.end, rects: seg.rects }],
      color,
      text: seg.text,
      tags: kind === 'highlight' ? ['key-idea'] : [],
      kind,
      createdAt: Date.now(),
    });
    const ws = data.workspaces[0];
    const s1 = await find('Active reading frequently involves searching, highlighting, comparison, non-sequential navigation, and the like.');
    const s2 = await find('Excerpts let you regroup ideas by theme instead of by page number');
    const s3 = await find('Pinch the document vertically with two fingers to collapse the text in between');
    const h1 = await find('paper makes it hard to bring distant passages side by side');
    const items: WsItem[] = [];
    const note: WsItem = {
      id: uid(), type: 'note', x: 40, y: 30, w: 320, color: '#7fe3e0', fontSize: 20,
      text: '<b>Welcome to FluidNotes</b><br>This project shows how a document and a workspace work together. Drag text here, write with the Pencil, and link ideas.',
      tags: [], createdAt: Date.now(),
    };
    items.push(note);
    const head: WsItem = {
      id: uid(), type: 'note', x: 60, y: 210, w: 300, color: '#7fe3e0', fontSize: 15,
      text: 'Here are excerpts from the guide about active reading:', tags: [], createdAt: Date.now(),
    };
    items.push(head);
    let prev = head.id;
    for (const s of [s1, s2, s3]) {
      if (!s) continue;
      const h = mk(s, '#7fe3e0', 'excerpt');
      data.highlights.push(h);
      const it: WsItem = { id: uid(), type: 'excerpt', x: 60, y: 300, w: 300, text: h.text, color: '#7fe3e0', source: { docId: doc.id, hlId: h.id, page: s.page }, dockedTo: prev, tags: [], createdAt: Date.now() };
      items.push(it);
      prev = it.id;
    }
    if (h1) {
      const h = mk(h1, '#ffe600', 'highlight');
      data.highlights.push(h);
      const n2: WsItem = { id: uid(), type: 'note', x: 375, y: 470, w: 170, color: '#ffe066', fontSize: 15, text: 'This is exactly why we can collapse and excerpt. (Linked to a highlight →)', tags: [], createdAt: Date.now() };
      items.push(n2);
      data.links.push({ id: uid(), a: { kind: 'hl', id: h.id }, b: { kind: 'item', wsId: ws.id, id: n2.id }, color: '#e0a800' });
    }
    ws.items = items;
    // a little ink on the workspace
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= 30; i++) pts.push([30 + Math.sin(i / 30 * Math.PI) * -14, 290 + i * 8, 0.5 + 0.3 * Math.sin(i / 5)]);
    ws.ink.push({ id: uid(), points: pts, color: '#1a3fd6', width: 2.5, kind: 'pen' });
    ws.view = { x: 20, y: 10, zoom: 1 };
    await db.putData(id, data);
    const { makeThumb } = await import('./exporter');
    const meta = await db.getMeta(id);
    if (meta) await db.putMeta({ ...meta, thumb: await makeThumb(data) });
  } catch (e) {
    console.warn('sample decoration failed', e);
  }
  return id;
}
