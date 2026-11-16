import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { useUI, setUI, ui } from '../ui';
import { I } from './Icons';
import { runSearch, gotoHit, goToItem, highlightAllHits, excerptAllHits, goToDoc, goToHighlight, edit, docById, goToAnchor } from '../actions';
import { loadDoc, renderPage, getOutline } from '../pdf';
import { HL_COLORS, hlFill } from '../types';

export function SearchPanel() {
  const search = useUI((s) => s.search);
  const docs = useApp((s) => s.project!.data.docs);
  const [q, setQ] = useState(search.query);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => setQ(search.query), [search.query]);
  useEffect(() => {
    if (search.open) setTimeout(() => inp.current?.focus(), 50);
  }, [search.open]);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  if (!search.open) return null;
  const docName = (id: string) => docs.find((d) => d.id === id)?.name ?? '';
  const grouped = new Map<string, { i: number; h: (typeof search.hits)[number] }[]>();
  search.hits.forEach((h, i) => {
    const a = grouped.get(h.docId) || [];
    a.push({ i, h });
    grouped.set(h.docId, a);
  });
  return (
    <div className="side-panel search-panel">
      <div className="panel-head">
        <span className="ico">{I.search}</span>
        <input
          ref={inp}
          value={q}
          placeholder="Search documents and workspace"
          onChange={(e) => {
            const v = e.target.value;
            setQ(v);
            setUI({ search: { ...ui().search, query: v } });
            clearTimeout(timer.current);
            timer.current = setTimeout(() => runSearch(v), 220);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') gotoHit((search.active + 1) % Math.max(1, search.hits.length));
            if (e.key === 'Escape') setUI({ search: { ...search, open: false } });
          }}
        />
        <button className="icon-btn" onClick={() => setUI({ search: { ...search, open: false, hits: [], wsHits: [], query: '' } })}>{I.close}</button>
      </div>
      <div className="panel-sub">
        <span>{search.hits.length} in documents · {search.wsHits.length} in notes</span>
        <span className="grow" />
        <button disabled={!search.hits.length} onClick={() => gotoHit(Math.max(0, search.active - 1))}>▲</button>
        <button disabled={!search.hits.length} onClick={() => gotoHit((search.active + 1) % search.hits.length)}>▼</button>
      </div>
      {search.hits.length > 0 && (
        <div className="panel-actions">
          <span>Select results:</span>
          {HL_COLORS.slice(0, 4).map((c) => (
            <button key={c} className="swatch small" style={{ background: c }} onClick={() => highlightAllHits(c)} title="Highlight all" />
          ))}
          <button onClick={() => excerptAllHits()}>Excerpt all</button>
        </div>
      )}
      <div className="panel-body">
        {Array.from(grouped.entries()).map(([docId, arr]) => (
          <div key={docId}>
            <div className="group-title">{docName(docId)} <span>({arr.length})</span></div>
            {arr.slice(0, 400).map(({ i, h }) => (
              <button key={i} className={`result ${i === search.active ? 'active' : ''}`} onClick={() => gotoHit(i)}>
                <span className="pg">p.{h.page + 1}</span>
                <span className="snip">…{h.pre}<mark>{h.snippet}</mark>{h.post}…</span>
              </button>
            ))}
          </div>
        ))}
        {search.wsHits.length > 0 && <div className="group-title">Workspace & comments</div>}
        {search.wsHits.map((h, i) => (
          <button key={'w' + i} className="result" onClick={() => (h.itemId.startsWith('comment:') ? goToAnchor({ kind: 'comment', id: h.itemId.slice(8) }) : goToItem(h.itemId))}>
            <span className="snip">{h.snippet}</span>
          </button>
        ))}
        {search.query && !search.hits.length && !search.wsHits.length && <div className="empty">No results</div>}
      </div>
    </div>
  );
}

export function PagesPanel({ docId }: { docId: string }) {
  const doc = useApp((s) => s.project!.data.docs.find((d) => d.id === docId));
  const highlights = useApp((s) => s.project!.data.highlights);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (doc) loadDoc(doc.fileId).then((ld) => setN(ld.pages.length));
  }, [doc?.fileId]);
  if (!doc) return null;
  const annotated = new Set<number>();
  for (const h of highlights) if (h.docId === docId) for (const s of h.segments) annotated.add(s.page);
  return (
    <div className="side-panel left pages-panel">
      <div className="panel-head">
        <b>Pages</b>
        <span className="grow" />
        <button className="icon-btn" onClick={() => setUI({ panel: null })}>{I.close}</button>
      </div>
      <div className="panel-body thumbs">
        {Array.from({ length: n }, (_, i) => (
          <button key={i} className="thumb" onClick={() => goToDoc(docId, i, 0)}>
            <Thumb fileId={doc.fileId} page={i} />
            <span>{i + 1}{annotated.has(i) ? ' •' : ''}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Thumb({ fileId, page }: { fileId: string; page: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current!;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setVis(true));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!vis) return;
    loadDoc(fileId).then((ld) =>
      renderPage(ld, page, 0.25).then((bmp) => {
        const c = ref.current;
        if (!c) return;
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext('2d')!.drawImage(bmp, 0, 0);
      }),
    );
  }, [vis]);
  return <canvas ref={ref} className="thumb-canvas" />;
}

export function OutlinePanel({ docId }: { docId: string }) {
  const doc = useApp((s) => s.project!.data.docs.find((d) => d.id === docId));
  const bookmarks = useApp((s) => s.project!.data.bookmarks.filter((b) => b.docId === docId));
  const [ol, setOl] = useState<{ title: string; page: number; depth: number }[] | null>(null);
  useEffect(() => {
    if (doc) loadDoc(doc.fileId).then(getOutline).then(setOl);
  }, [doc?.fileId]);
  return (
    <div className="side-panel left">
      <div className="panel-head">
        <b>Contents & Bookmarks</b>
        <span className="grow" />
        <button className="icon-btn" onClick={() => setUI({ panel: null })}>{I.close}</button>
      </div>
      <div className="panel-body">
        <div className="group-title">Bookmarks</div>
        {!bookmarks.length && <div className="empty small">No bookmarks. Use the bookmark button or select text → Bookmark.</div>}
        {bookmarks.map((b) => (
          <div key={b.id} className="row-item">
            <button className="result" onClick={() => goToDoc(docId, b.page, b.y)}>
              <span className="pg">p.{b.page + 1}</span>
              <span className="snip">{b.name}</span>
            </button>
            <button className="icon-btn small" onClick={() => {
              const name = prompt('Rename bookmark', b.name);
              if (name) edit((d) => { const x = d.bookmarks.find((z) => z.id === b.id); if (x) x.name = name; });
            }}>✎</button>
            <button className="icon-btn small" onClick={() => edit((d) => { d.bookmarks = d.bookmarks.filter((z) => z.id !== b.id); })}>{I.trash}</button>
          </div>
        ))}
        <div className="group-title">Table of contents</div>
        {ol === null && <div className="empty small">Loading…</div>}
        {ol && !ol.length && <div className="empty small">This document has no outline.</div>}
        {ol?.map((o, i) => (
          <button key={i} className="result" style={{ paddingLeft: 10 + o.depth * 14 }} disabled={o.page < 0} onClick={() => goToDoc(docId, o.page, 0)}>
            <span className="snip">{o.title}</span>
            <span className="pg">{o.page >= 0 ? o.page + 1 : ''}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function AnnotationsPanel() {
  const d = useApp((s) => s.project!.data);
  const [filter, setFilter] = useState<'all' | 'highlights' | 'comments' | 'excerpts' | 'ink'>('all');
  const [tag, setTag] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(null);
  const rows = useMemo(() => {
    const out: { key: string; docId: string; page: number; y: number; color: string; text: string; kind: string; tags: string[]; go: () => void }[] = [];
    if (filter === 'all' || filter === 'highlights' || filter === 'excerpts')
      for (const h of d.highlights) {
        if (filter === 'highlights' && h.kind === 'excerpt') continue;
        if (filter === 'excerpts' && h.kind !== 'excerpt') continue;
        if (h.kind === 'comment') continue;
        const s = h.segments[0];
        if (!s) continue;
        out.push({ key: h.id, docId: h.docId, page: s.page, y: s.rects[0]?.[1] ?? 0, color: h.kind === 'excerpt' ? '#2bb5b0' : h.color, text: h.text, kind: h.kind, tags: h.tags, go: () => goToHighlight(h.id) });
      }
    if (filter === 'all' || filter === 'comments')
      for (const c of d.comments) {
        const h = d.highlights.find((x) => x.id === c.hlId);
        out.push({ key: c.id, docId: c.docId, page: c.page, y: c.y, color: '#f0b400', text: (c.text || '(empty comment)') + (h ? `  —  "${h.text.slice(0, 80)}"` : ''), kind: 'comment', tags: [], go: () => goToAnchor({ kind: 'comment', id: c.id }) });
      }
    if (filter === 'all' || filter === 'ink')
      for (const s of d.docInk) out.push({ key: s.id, docId: s.docId, page: s.page, y: s.points[0]?.[1] ?? 0, color: s.color, text: 'Ink', kind: 'ink', tags: [], go: () => goToDoc(s.docId, s.page, s.points[0]?.[1] ?? 0) });
    return out
      .filter((r) => (!tag || r.tags.includes(tag)) && (!color || r.color === color))
      .sort((a, b) => (a.docId === b.docId ? a.page - b.page || a.y - b.y : a.docId.localeCompare(b.docId)));
  }, [d, filter, tag, color]);
  const colors = Array.from(new Set(d.highlights.filter((h) => h.kind === 'highlight').map((h) => h.color)));
  return (
    <div className="side-panel left annotations-panel">
      <div className="panel-head">
        <b>Annotations</b>
        <span className="grow" />
        <button className="icon-btn" onClick={() => setUI({ panel: null })}>{I.close}</button>
      </div>
      <div className="seg-ctl">
        {(['all', 'highlights', 'comments', 'excerpts', 'ink'] as const).map((f) => (
          <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>
        ))}
      </div>
      <div className="panel-actions">
        {colors.map((c) => (
          <button key={c} className={`swatch small ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(color === c ? null : c)} />
        ))}
        {d.tags.map((t) => (
          <button key={t} className={`tag ${tag === t ? 'on' : ''}`} onClick={() => setTag(tag === t ? null : t)}>#{t}</button>
        ))}
      </div>
      <div className="panel-body">
        {!rows.length && <div className="empty">Nothing here yet.</div>}
        {rows.map((r) => (
          <button key={r.key} className="result annot" onClick={r.go}>
            <span className="dot" style={{ background: r.kind === 'highlight' ? hlFill(r.color) : r.color }} />
            <span className="snip">
              <small>{docById(r.docId)?.name} · p.{r.page + 1}</small>
              {r.text.slice(0, 220)}
              {r.tags.length > 0 && <em> {r.tags.map((t) => '#' + t).join(' ')}</em>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
