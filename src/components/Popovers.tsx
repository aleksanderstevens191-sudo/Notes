import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp, uid } from '../store';
import { useUI, setUI, ui } from '../ui';
import { HL_COLORS, NOTE_COLORS, PEN_COLORS } from '../types';
import {
  createHighlight, clearHighlightsInSelection, createExcerpt, addComment, selectionSegments, data, edit, deleteHighlight,
  createExcerptFromHighlight, goToItem, deleteItems, goToSource, linksFor, goToAnchor, createImageExcerpt, runSearch, copyDeepLink,
} from '../actions';
import { regionText, regionRange, cropPage } from './DocView';
import { loadDoc } from '../pdf';
import { anchorKey } from '../ui';

function Pop({ x, y, children, className = '', anchor = 'above' }: { x: number; y: number; children: React.ReactNode; className?: string; anchor?: 'above' | 'below' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth,
      h = el.offsetHeight;
    let left = x - w / 2;
    let top = anchor === 'above' ? y - h - 14 : y + 14;
    if (top < 60) top = y + 30;
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    top = Math.max(60, Math.min(window.innerHeight - h - 8, top));
    setPos({ left, top, ready: true });
  }, [x, y, children]);
  return (
    <div
      ref={ref}
      className={`popover ${className}`}
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

export function Popovers() {
  const pop = useUI((s) => s.popover);
  if (!pop) return null;
  switch (pop.kind) {
    case 'selection':
      return <SelectionMenu x={pop.x} y={pop.y} />;
    case 'highlight':
      return <HighlightMenu id={pop.id} x={pop.x} y={pop.y} />;
    case 'item':
      return <ItemMenu ids={pop.ids} x={pop.x} y={pop.y} />;
    case 'comment':
      return <CommentPop id={pop.id} x={pop.x} y={pop.y} />;
    case 'lassoDoc':
      return <LassoDocMenu {...pop} />;
    case 'link':
      return <LinkMenu id={pop.id} x={pop.x} y={pop.y} />;
    case 'tags':
      return <TagsPop target={pop.target} x={pop.x} y={pop.y} />;
  }
}

function ColorRow({ onPick, onClear, current }: { onPick: (c: string) => void; onClear?: () => void; current?: string }) {
  const [custom, setCustom] = useState('#ff8800');
  return (
    <div className="color-row">
      {HL_COLORS.map((c) => (
        <button key={c} className={`swatch ${current === c ? 'on' : ''}`} style={{ background: c }} onClick={() => onPick(c)} aria-label={'Highlight ' + c} />
      ))}
      {onClear && (
        <button className="swatch clear" onClick={onClear} aria-label="Clear highlight">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 19L19 5" stroke="#777" strokeWidth="2" /></svg>
        </button>
      )}
      <label className="swatch rainbow" aria-label="Custom colour">
        <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} onBlur={() => onPick(custom)} />
      </label>
    </div>
  );
}

function SelectionMenu({ x, y }: { x: number; y: number }) {
  const sel = useUI((s) => s.sel);
  const hlColor = useApp((s) => s.settings.hlColor);
  const [more, setMore] = useState(false);
  if (!sel) return null;
  const close = () => setUI({ sel: null, popover: null });
  const text = () => selectionSegments(sel).text;
  return (
    <Pop x={x} y={y} className="sel-menu">
      <div className="menu-row">
        <button onClick={() => {
          const id = addComment(sel);
          setUI({ sel: null });
          if (id) setTimeout(() => {
            const el = document.querySelector(`[data-anchor="comment:${id}"]`);
            const r = el?.getBoundingClientRect();
            setUI({ popover: { kind: 'comment', id, x: r ? r.right : x, y: r ? r.top : y } });
          }, 60);
        }}>Comment</button>
        <button onClick={() => {
          const id = createExcerpt(sel);
          close();
          if (id) setTimeout(() => goToItem(id), 50);
        }}>Excerpt</button>
        <button onClick={() => {
          navigator.clipboard?.writeText(text()).then(() => useApp.getState().showToast('Copied'));
          close();
        }}>Copy</button>
        <button onClick={() => {
          const t = text();
          setUI({ search: { ...ui().search, open: true, query: t }, sel: null, popover: null });
          runSearch(t);
        }}>Search</button>
        <button onClick={() => {
          const { segments, text: t } = selectionSegments(sel);
          const sg = segments[0];
          if (sg) edit((d) => {
            d.bookmarks.push({ id: uid(), docId: sel.docId, page: sg.page, y: sg.rects[0][1], name: t.slice(0, 60) || `Page ${sg.page + 1}` });
          });
          useApp.getState().showToast('Bookmark added');
          close();
        }}>Bookmark</button>
        <button className="more" onClick={() => setMore(!more)}>•••</button>
      </div>
      {more && (
        <div className="menu-row secondary">
          <button onClick={() => {
            createHighlight(sel, hlColor, 'underline');
            close();
          }}>Underline</button>
          <button onClick={() => {
            createHighlight(sel, '#d92b2b', 'strike');
            close();
          }}>Strikethrough</button>
          <button onClick={() => {
            const id = createHighlight(sel, hlColor);
            if (id) setUI({ linkFrom: { kind: 'hl', id }, sel: null, popover: null });
            useApp.getState().showToast('Tap something to link to');
          }}>Link to…</button>
          <button onClick={() => {
            const t = text();
            window.open('https://www.google.com/search?q=' + encodeURIComponent(t), '_blank');
          }}>Look up</button>
          <button onClick={() => {
            const id = createHighlight(sel, hlColor);
            if (id) copyDeepLink({ hl: id });
            close();
          }}>Copy Link</button>
          <button onClick={() => {
            const id = createHighlight(sel, hlColor);
            if (id) setUI({ sel: null, popover: { kind: 'tags', target: { type: 'hl', ids: [id] }, x, y } });
          }}>Tag…</button>
        </div>
      )}
      <div className="menu-row colors">
        <ColorRow
          current={hlColor}
          onPick={(c) => {
            createHighlight(sel, c);
            useApp.getState().setSettings({ hlColor: c });
            close();
          }}
          onClear={() => {
            clearHighlightsInSelection(sel);
            close();
          }}
        />
        <span className="sep" />
        <button className="tags-btn" onClick={() => {
          const id = createHighlight(sel, hlColor);
          if (id) setUI({ sel: null, popover: { kind: 'tags', target: { type: 'hl', ids: [id] }, x, y } });
        }}>Tags</button>
      </div>
    </Pop>
  );
}

function HighlightMenu({ id, x, y }: { id: string; x: number; y: number }) {
  const h = useApp((s) => s.project!.data.highlights.find((x) => x.id === id));
  const item = useApp((s) => {
    for (const w of s.project!.data.workspaces) for (const it of w.items) if (it.source?.hlId === id) return it;
    return null;
  });
  if (!h) return null;
  const close = () => setUI({ popover: null });
  const links = linksFor('hl:' + id);
  return (
    <Pop x={x} y={y} className="sel-menu">
      <div className="menu-row">
        {item && <button onClick={() => { close(); goToItem(item.id); }}>Show excerpt</button>}
        {links.length > 0 && <button onClick={() => { close(); const l = links[0]; goToAnchor(anchorKey(l.a) === 'hl:' + id ? l.b : l.a); }}>Follow link</button>}
        <button onClick={() => {
          close();
          const cid = addComment(null, id);
          if (cid) setTimeout(() => {
            const el = document.querySelector(`[data-anchor="comment:${cid}"]`);
            const r = el?.getBoundingClientRect();
            setUI({ popover: { kind: 'comment', id: cid, x: r ? r.right : x, y: r ? r.top : y } });
          }, 60);
        }}>Comment</button>
        {h.kind !== 'excerpt' && <button onClick={() => { const iid = createExcerptFromHighlight(id); close(); if (iid) setTimeout(() => goToItem(iid), 50); }}>Excerpt</button>}
        <button onClick={() => { navigator.clipboard?.writeText(h.text); useApp.getState().showToast('Copied'); close(); }}>Copy</button>
        <button onClick={() => { setUI({ linkFrom: { kind: 'hl', id }, popover: null }); useApp.getState().showToast('Tap something to link to'); }}>Link…</button>
        <button onClick={() => { copyDeepLink({ hl: id }); close(); }}>Copy Link</button>
        <button onClick={() => setUI({ popover: { kind: 'tags', target: { type: 'hl', ids: [id] }, x, y } })}>Tags</button>
        {h.kind !== 'excerpt' && <button className="danger" onClick={() => deleteHighlight(id)}>Delete</button>}
      </div>
      {h.kind !== 'excerpt' && (
        <div className="menu-row colors">
          <ColorRow
            current={h.color}
            onPick={(c) => {
              edit((d) => {
                const hh = d.highlights.find((x) => x.id === id);
                if (hh) {
                  hh.color = c;
                  if (hh.kind === 'comment') hh.kind = 'highlight';
                }
              });
              close();
            }}
            onClear={() => deleteHighlight(id)}
          />
        </div>
      )}
      {h.tags.length > 0 && <div className="menu-tags">{h.tags.map((t) => <span className="tag" key={t}>#{t}</span>)}</div>}
    </Pop>
  );
}

function ItemMenu({ ids, x, y }: { ids: string[]; x: number; y: number }) {
  const ws = useApp((s) => s.project!.data.workspaces.find((w) => w.id === s.project!.data.activeWs)!);
  const inkSel = useUI((s) => s.wsInkSel);
  const items = ws.items.filter((i) => ids.includes(i.id));
  const [showColors, setShowColors] = useState(false);
  const close = () => setUI({ popover: null });
  const one = items.length === 1 ? items[0] : null;
  if (!items.length && !inkSel.length) return null;
  return (
    <Pop x={x} y={y} className="sel-menu">
      <div className="menu-row">
        {one?.source && <button onClick={() => { close(); goToSource(one); }}>Source</button>}
        {one && <button onClick={() => setUI({ editingItem: one.id, popover: null })}>Edit</button>}
        {items.length > 0 && <button onClick={() => setShowColors(!showColors)}>Color</button>}
        {one && <button onClick={() => { setUI({ linkFrom: { kind: 'item', wsId: ws.id, id: one.id }, popover: null }); useApp.getState().showToast('Tap something to link to'); }}>Link…</button>}
        {one && <button onClick={() => { copyDeepLink({ item: one.id }); close(); }}>Copy Link</button>}
        {one && linksFor('item:' + one.id).length > 0 && <button onClick={() => { close(); const l = linksFor('item:' + one.id)[0]; goToAnchor(anchorKey(l.a) === 'item:' + one.id ? l.b : l.a); }}>Follow link</button>}
        {items.length > 0 && <button onClick={() => setUI({ popover: { kind: 'tags', target: { type: 'item', ids: items.map((i) => i.id) }, x, y } })}>Tags</button>}
        {items.length > 0 && <button onClick={() => {
          const t = items.map((i) => (i.type === 'note' ? (new DOMParser().parseFromString(i.text, 'text/html').body.innerText) : i.text)).join('\n\n');
          navigator.clipboard?.writeText(t);
          useApp.getState().showToast('Copied');
          close();
        }}>Copy</button>}
        {items.length > 0 && <button onClick={() => {
          edit((d) => {
            const w = d.workspaces.find((x) => x.id === ws.id)!;
            for (const it of items) w.items.push({ ...JSON.parse(JSON.stringify(it)), id: uid(), x: it.x + 30, y: it.y + 30, dockedTo: undefined });
          });
          close();
        }}>Duplicate</button>}
        {one?.dockedTo && <button onClick={() => {
          edit((d) => {
            const w = d.workspaces.find((x) => x.id === ws.id)!;
            const it = w.items.find((x) => x.id === one.id)!;
            const child = w.items.find((x) => x.dockedTo === one.id);
            if (child) child.dockedTo = it.dockedTo;
            it.dockedTo = undefined;
            it.x += it.w + 40;
          });
          close();
        }}>Unstack</button>}
        {items.length > 1 && <button onClick={() => {
          // stack selected cards into one column
          const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
          edit((d) => {
            const w = d.workspaces.find((x) => x.id === ws.id)!;
            for (let i = 1; i < sorted.length; i++) {
              const it = w.items.find((x) => x.id === sorted[i].id)!;
              const child = w.items.find((x) => x.dockedTo === it.id);
              if (child && !ids.includes(child.id)) child.dockedTo = it.dockedTo;
              it.dockedTo = sorted[i - 1].id;
            }
            w.items.find((x) => x.id === sorted[0].id)!.dockedTo = undefined;
          });
          close();
        }}>Stack</button>}
        {items.length > 0 && <button onClick={() => {
          const t = items.map((i) => (i.type === 'note' ? new DOMParser().parseFromString(i.text, 'text/html').body.innerText : i.text)).join(' ');
          setUI({ search: { ...ui().search, open: true, query: t.slice(0, 80) }, popover: null });
          runSearch(t.slice(0, 80));
        }}>Search</button>}
        <button className="danger" onClick={() => {
          if (inkSel.length) edit((d) => {
            const w = d.workspaces.find((x) => x.id === ws.id)!;
            w.ink = w.ink.filter((s) => !inkSel.includes(s.id));
          });
          if (items.length) deleteItems(items.map((i) => i.id));
          setUI({ wsInkSel: [], wsSel: [], popover: null });
        }}>Delete</button>
      </div>
      {showColors && (
        <div className="menu-row colors">
          {NOTE_COLORS.map((c) => (
            <button key={c} className="swatch" style={{ background: c }} onClick={() => {
              edit((d) => {
                for (const it of d.workspaces.find((x) => x.id === ws.id)!.items) if (ids.includes(it.id)) it.color = c;
              });
            }} />
          ))}
          {one && (
            <>
              <span className="sep" />
              <button onClick={() => edit((d) => { const it = d.workspaces.find((x) => x.id === ws.id)!.items.find((x) => x.id === one.id)!; it.fontSize = Math.max(9, (it.fontSize ?? 14) - 2); })}>A−</button>
              <button onClick={() => edit((d) => { const it = d.workspaces.find((x) => x.id === ws.id)!.items.find((x) => x.id === one.id)!; it.fontSize = Math.min(64, (it.fontSize ?? 14) + 2); })}>A+</button>
            </>
          )}
        </div>
      )}
      {one?.type === 'note' && <NoteFormatRow />}
    </Pop>
  );
}

function NoteFormatRow() {
  const cmd = (c: string, v?: string) => document.execCommand(c, false, v);
  return (
    <div className="menu-row secondary" onPointerDown={(e) => e.preventDefault()}>
      <button onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('bold')}><b>B</b></button>
      <button onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('italic')}><i>I</i></button>
      <button onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('underline')}><u>U</u></button>
      <button onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('insertUnorderedList')}>• List</button>
      <button onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('insertOrderedList')}>1. List</button>
      {PEN_COLORS.slice(0, 5).map((c) => (
        <button key={c} className="swatch small" style={{ background: c }} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('foreColor', c)} />
      ))}
    </div>
  );
}

function CommentPop({ id, x, y }: { id: string; x: number; y: number }) {
  const c = useApp((s) => s.project!.data.comments.find((cc) => cc.id === id));
  const [text, setText] = useState(c?.text ?? '');
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setTimeout(() => ta.current?.focus(), 30);
  }, []);
  if (!c) return null;
  const save = () => {
    if (text !== c.text) edit((d) => {
      const cc = d.comments.find((z) => z.id === id);
      if (cc) cc.text = text;
    });
  };
  return (
    <Pop x={x} y={y} className="comment-pop" anchor="below">
      <div className="comment-head">Comment</div>
      <textarea
        ref={ta}
        value={text}
        placeholder="Write a comment… (Apple Pencil Scribble works here)"
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
      />
      <div className="menu-row">
        <button onClick={() => { save(); setUI({ popover: null }); }}>Done</button>
        <button onClick={() => {
          save();
          // move comment to workspace as a linked note
          const nid = uid();
          edit((d) => {
            const ws = d.workspaces.find((w) => w.id === d.activeWs)!;
            const v = ws.view;
            ws.items.push({ id: nid, type: 'note', x: (-v.x + 60) / v.zoom, y: (-v.y + 80) / v.zoom, w: 240, text: text.replace(/</g, '&lt;').replace(/\n/g, '<br>'), color: '#ffd36b', fontSize: 15, tags: [], createdAt: Date.now() });
            if (c.hlId) d.links.push({ id: uid(), a: { kind: 'hl', id: c.hlId }, b: { kind: 'item', wsId: ws.id, id: nid }, color: '#e0a800' });
            d.comments = d.comments.filter((z) => z.id !== id);
          });
          setUI({ popover: null });
          setTimeout(() => goToItem(nid), 50);
        }}>Move to workspace</button>
        <button className="danger" onClick={() => {
          edit((d) => {
            d.comments = d.comments.filter((z) => z.id !== id);
            if (c.hlId) {
              const h = d.highlights.find((hh) => hh.id === c.hlId);
              if (h && h.kind === 'comment') d.highlights = d.highlights.filter((hh) => hh.id !== c.hlId);
            }
          });
          setUI({ popover: null });
        }}>Delete</button>
      </div>
    </Pop>
  );
}

function LassoDocMenu(p: { docId: string; page: number; rect: [number, number, number, number]; strokeIds: string[]; x: number; y: number }) {
  const hlColor = useApp((s) => s.settings.hlColor);
  const close = () => {
    setUI({ popover: null });
  };
  const clearLasso = () => window.dispatchEvent(new CustomEvent('doc-action', { detail: { docId: p.docId, action: 'clearLasso' } }));
  return (
    <Pop x={p.x} y={p.y} className="sel-menu">
      <div className="menu-row">
        <button onClick={async () => {
          const d = data().docs.find((x) => x.id === p.docId)!;
          const ld = await loadDoc(d.fileId);
          const img = await cropPage(ld, p.page, p.rect, 2.5);
          const txt = await regionText(p.docId, p.page, p.rect);
          const id = createImageExcerpt(p.docId, p.page, p.rect, img, txt);
          close();
          clearLasso();
          setTimeout(() => goToItem(id), 50);
        }}>Excerpt region</button>
        <button onClick={async () => {
          const r = await regionRange(p.docId, p.page, p.rect);
          if (r) {
            const id = createExcerpt(r);
            if (id) setTimeout(() => goToItem(id), 50);
          } else useApp.getState().showToast('No text in region');
          close();
          clearLasso();
        }}>Excerpt text</button>
        <button onClick={async () => {
          const r = await regionRange(p.docId, p.page, p.rect);
          if (r) createHighlight(r, hlColor);
          close();
          clearLasso();
        }}>Highlight</button>
        <button onClick={async () => {
          const t = await regionText(p.docId, p.page, p.rect);
          navigator.clipboard?.writeText(t);
          useApp.getState().showToast(t ? 'Copied' : 'No text in region');
          close();
        }}>Copy text</button>
        {p.strokeIds.length > 0 && (
          <button className="danger" onClick={() => {
            edit((d) => {
              d.docInk = d.docInk.filter((s) => !p.strokeIds.includes(s.id));
            });
            close();
            clearLasso();
          }}>Delete ink</button>
        )}
      </div>
      {p.strokeIds.length > 0 && (
        <div className="menu-row colors">
          {PEN_COLORS.map((c) => (
            <button key={c} className="swatch" style={{ background: c }} onClick={() => edit((d) => {
              for (const s of d.docInk) if (p.strokeIds.includes(s.id)) s.color = c;
            })} />
          ))}
          <span className="hint">Drag the box to move ink</span>
        </div>
      )}
    </Pop>
  );
}

function LinkMenu({ id, x, y }: { id: string; x: number; y: number }) {
  const l = useApp((s) => s.project!.data.links.find((k) => k.id === id));
  if (!l) return null;
  return (
    <Pop x={x} y={y} className="sel-menu">
      <div className="menu-row">
        <button onClick={() => { setUI({ popover: null }); goToAnchor(l.a); }}>Go to start</button>
        <button onClick={() => { setUI({ popover: null }); goToAnchor(l.b); }}>Go to end</button>
        {PEN_COLORS.slice(1, 6).map((c) => (
          <button key={c} className="swatch small" style={{ background: c }} onClick={() => edit((d) => { const k = d.links.find((z) => z.id === id); if (k) k.color = c; })} />
        ))}
        <button className="danger" onClick={() => { edit((d) => { d.links = d.links.filter((z) => z.id !== id); }); setUI({ popover: null }); }}>Delete link</button>
      </div>
    </Pop>
  );
}

function TagsPop({ target, x, y }: { target: { type: 'hl' | 'item'; ids: string[] }; x: number; y: number }) {
  const allTags = useApp((s) => s.project!.data.tags);
  const current = useApp((s) => {
    const d = s.project!.data;
    if (target.type === 'hl') return d.highlights.find((h) => h.id === target.ids[0])?.tags ?? [];
    for (const w of d.workspaces) for (const it of w.items) if (it.id === target.ids[0]) return it.tags;
    return [];
  });
  const [val, setVal] = useState('');
  const toggle = (t: string) => {
    edit((d) => {
      if (!d.tags.includes(t)) d.tags.push(t);
      const on = !current.includes(t);
      const apply = (arr: string[]) => (on ? (arr.includes(t) ? arr : [...arr, t]) : arr.filter((z) => z !== t));
      if (target.type === 'hl') for (const h of d.highlights) { if (target.ids.includes(h.id)) h.tags = apply(h.tags); }
      else for (const w of d.workspaces) for (const it of w.items) if (target.ids.includes(it.id)) it.tags = apply(it.tags);
    });
  };
  return (
    <Pop x={x} y={y} className="tags-pop">
      <div className="comment-head">Tags</div>
      <div className="tag-list">
        {allTags.map((t) => (
          <button key={t} className={`tag ${current.includes(t) ? 'on' : ''}`} onClick={() => toggle(t)}>#{t}</button>
        ))}
        {!allTags.length && <span className="hint">No tags yet</span>}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); const t = val.trim().replace(/^#/, ''); if (t) toggle(t); setVal(''); }}>
        <input value={val} onChange={(e) => setVal(e.target.value)} placeholder="New tag…" autoFocus />
      </form>
      <div className="menu-row"><button onClick={() => setUI({ popover: null })}>Done</button></div>
    </Pop>
  );
}
