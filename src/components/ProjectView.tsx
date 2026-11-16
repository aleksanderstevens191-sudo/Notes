import React, { useEffect, useRef, useState } from 'react';
import { useApp, uid } from '../store';
import { useUI, setUI, ui } from '../ui';
import { I } from './Icons';
import { DocView } from './DocView';
import { Workspace } from './Workspace';
import { LinkOverlay } from './LinkOverlay';
import { Popovers } from './Popovers';
import { SearchPanel, PagesPanel, OutlinePanel, AnnotationsPanel } from './Panels';
import { mountLiveLayer } from '../liveInk';
import { navBack, navForward, createNote, edit, currentNavEntry, data, loadedFor } from '../actions';
import { PEN_COLORS, HL_COLORS, type Tool } from '../types';
import { AddDocModal } from './Modals';
import { exportAnnotatedPdf, exportOriginalPdf, exportWorkspacePng, exportWorkspacePdf, exportNotes, exportProjectFile, printDoc, makeThumb } from '../exporter';
import { HelpModal, SettingsModal, Menu } from './Modals';

export function ProjectView() {
  const project = useApp((s) => s.project!);
  const tool = useApp((s) => s.tool);
  const undoN = useApp((s) => s.undo.length);
  const redoN = useApp((s) => s.redo.length);
  const openDocs = useUI((s) => s.openDocs);
  const ratio = useUI((s) => s.docRatio);
  const panel = useUI((s) => s.panel);
  const drag = useUI((s) => s.drag);
  const linkFrom = useUI((s) => s.linkFrom);
  const modal = useUI((s) => s.modal);
  const nav = useUI((s) => s.nav);
  const search = useUI((s) => s.search);
  const docs = project.data.docs;
  const mainRef = useRef<HTMLDivElement>(null);
  const [mainW, setMainW] = useState(1000);
  const [toolMenu, setToolMenu] = useState<Tool | null>(null);
  const [menu, setMenu] = useState<null | 'share' | 'more' | 'doc' | 'ws'>(null);

  // initial open docs
  useEffect(() => {
    const valid = ui().openDocs.filter((id) => docs.some((d) => d.id === id));
    if (!valid.length && docs[0]) setUI({ openDocs: [docs[0].id] });
    else if (valid.length !== ui().openDocs.length) setUI({ openDocs: valid });
  }, [docs.length]);

  useEffect(() => {
    // reset transient state when opening a project
    setUI({ sel: null, popover: null, wsSel: [], wsInkSel: [], panel: null, nav: { back: [], fwd: [] }, linkFrom: null, search: { open: false, query: '', hits: [], wsHits: [], active: -1, scope: 'all' } });
    return () => {
      setUI({ openDocs: [] });
    };
  }, [project.meta.id]);

  useEffect(() => {
    const el = mainRef.current!;
    const ro = new ResizeObserver(() => setMainW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // keyboard shortcuts (Magic Keyboard / desktop)
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,[contenteditable="true"]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) useApp.getState().doRedo();
        else useApp.getState().doUndo();
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setUI({ search: { ...ui().search, open: true } });
      } else if (!mod) {
        const map: Record<string, Tool> = { v: 'select', t: 'select', p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso' };
        if (map[e.key]) useApp.getState().setTool(map[e.key]);
        if (e.key === 'Escape') setUI({ sel: null, popover: null, wsSel: [], linkFrom: null });
        if ((e.key === 'Backspace' || e.key === 'Delete') && ui().wsSel.length) {
          import('../actions').then((a) => a.deleteItems(ui().wsSel));
        }
        if (e.key === 'n') createNote();
      }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, []);

  const goHome = async () => {
    const thumb = await makeThumb(data());
    if (thumb) useApp.getState().setThumb(thumb);
    useApp.getState().closeProject();
  };

  const pickTool = (t: Tool) => {
    if (tool === t && t !== 'select') setToolMenu(toolMenu === t ? null : t);
    else {
      useApp.getState().setTool(t);
      setToolMenu(null);
    }
    setUI({ popover: null, sel: t === 'select' ? ui().sel : null });
  };

  // divider drag
  const divRef = useRef<{ x0: number; r0: number; t: number } | null>(null);
  const lastDivTap = useRef(0);
  const docW = Math.round(mainW * ratio);
  const wsW = mainW - docW - 10;

  const activeDocId = openDocs[0];
  const activeDoc = docs.find((d) => d.id === activeDocId);

  return (
    <div className="project">
      <header className="toolbar">
        <div className="tb-group">
          <button className="icon-btn" title="Library" onClick={goHome}>{I.home}</button>
          <button className="icon-btn" title="Back" disabled={!nav.back.length} onClick={navBack}>{I.back}</button>
          <button className="icon-btn" title="Forward" disabled={!nav.fwd.length} onClick={navForward}>{I.fwd}</button>
          <button className="icon-btn" title="Add document" onClick={() => setUI({ modal: { kind: 'addDoc' } })}>{I.importDoc}</button>
          <button className="icon-btn" title="Undo" disabled={!undoN} onClick={() => useApp.getState().doUndo()}>{I.undo}</button>
          <button className="icon-btn" title="Redo" disabled={!redoN} onClick={() => useApp.getState().doRedo()}>{I.redo}</button>
        </div>
        <div className="tb-group tools">
          {([
            ['select', I.textTool, 'Select text & objects'],
            ['pen', I.pen, 'Pen'],
            ['highlighter', I.highlighter, 'Highlighter'],
            ['eraser', I.eraser, 'Eraser'],
            ['lasso', I.lasso, 'Lasso'],
          ] as [Tool, React.ReactNode, string][]).map(([t, ic, label]) => (
            <button key={t} className={`icon-btn tool ${tool === t ? 'active' : ''}`} title={label} onClick={() => pickTool(t)}>
              {ic}
              {(t === 'pen' || t === 'highlighter') && <ToolDot tool={t} />}
            </button>
          ))}
        </div>
        <div className="tb-group right">
          <div className="title" onClick={() => {
            const n = prompt('Rename project', project.meta.name);
            if (n) useApp.getState().renameProject(project.meta.id, n);
          }}>{project.meta.name}</div>
          <button className="share-btn" onClick={() => setMenu(menu === 'share' ? null : 'share')}>{I.share}<span>Share</span></button>
          <button className={`icon-btn ${search.open ? 'active-soft' : ''}`} title="Search" onClick={() => setUI({ search: { ...search, open: !search.open } })}>{I.search}</button>
          <button className="icon-btn" title="Help" onClick={() => setUI({ modal: { kind: 'help' } })}>{I.help}</button>
          <button className="icon-btn" title="More" onClick={() => setMenu(menu === 'more' ? null : 'more')}>{I.more}</button>
        </div>
        {toolMenu && <ToolPalette tool={toolMenu} onClose={() => setToolMenu(null)} />}
        {menu === 'share' && (
          <Menu onClose={() => setMenu(null)} style={{ right: 150, top: 54 }}>
            {activeDoc && <button onClick={() => exportAnnotatedPdf(activeDoc.id)}>Annotated PDF – {activeDoc.name}</button>}
            {activeDoc && <button onClick={() => exportOriginalPdf(activeDoc.id)}>Original PDF – {activeDoc.name}</button>}
            <button onClick={() => exportWorkspacePng()}>Workspace as image (PNG)</button>
            <button onClick={() => exportWorkspacePdf()}>Workspace as PDF</button>
            <button onClick={() => exportNotes()}>Notes & excerpts summary (Markdown)</button>
            <button onClick={async () => { await useApp.getState().save(); exportProjectFile(project.meta.id); }}>Project file (backup / send to another device)</button>
            {activeDoc && <button onClick={() => printDoc(activeDoc.id)}>Print…</button>}
          </Menu>
        )}
        {menu === 'more' && (
          <Menu onClose={() => setMenu(null)} style={{ right: 8, top: 54 }}>
            <button onClick={() => setUI({ modal: { kind: 'settings' } })}>Settings…</button>
            <button onClick={() => { const n = prompt('Rename project', project.meta.name); if (n) useApp.getState().renameProject(project.meta.id, n); }}>Rename project…</button>
            <button onClick={() => setUI({ docRatio: 0.45 })}>Reset layout</button>
            <button onClick={() => setUI({ docRatio: 0.98 })}>Document only</button>
            <button onClick={() => setUI({ docRatio: 0.02 })}>Workspace only</button>
            <button onClick={() => setUI({ panel: 'annotations' })}>All annotations…</button>
            <button onClick={() => {
              if (confirm('Remove all ink from documents in this project?')) edit((d) => { d.docInk = []; });
            }}>Clear document ink…</button>
          </Menu>
        )}
      </header>

      <div className="main" ref={mainRef}>
        <section className="doc-pane" style={{ width: docW }}>
          {activeDoc ? (
            <>
              <div className="doc-header">
                <button className="doc-title" onClick={() => setMenu(menu === 'doc' ? null : 'doc')}>
                  <span className="chev">▼</span> {activeDoc.name}
                </button>
                <span className="grow" />
                {openDocs.length > 1 && <span className="hint">{docs.find((d) => d.id === openDocs[1])?.name}</span>}
                <button className={`icon-btn small ${openDocs.length > 1 ? 'active-soft' : ''}`} title="Two documents side by side" onClick={() => {
                  if (openDocs.length > 1) setUI({ openDocs: [openDocs[0]] });
                  else if (docs.length > 1) setUI({ openDocs: [openDocs[0], docs.find((d) => d.id !== openDocs[0])!.id] });
                  else useApp.getState().showToast('Add another document to view side by side');
                }}>{I.split}</button>
              </div>
              {menu === 'doc' && (
                <Menu onClose={() => setMenu(null)} style={{ left: 40, top: 98 }}>
                  {docs.map((d) => (
                    <button key={d.id} className={d.id === activeDocId ? 'on' : ''} onClick={() => setUI({ openDocs: openDocs.length > 1 ? [d.id, openDocs[1] === d.id ? openDocs[0] : openDocs[1]] : [d.id] })}>
                      {d.name} <small>{d.pageCount} pages</small>
                    </button>
                  ))}
                  <hr />
                  <button onClick={() => setUI({ modal: { kind: 'addDoc' } })}>+ Add document…</button>
                  <button onClick={() => {
                    const n = prompt('Rename document', activeDoc.name);
                    if (n) edit((d) => { const x = d.docs.find((z) => z.id === activeDoc.id); if (x) x.name = n; });
                  }}>Rename “{activeDoc.name}”…</button>
                  {docs.length > 1 && <button className="danger" onClick={() => {
                    if (!confirm(`Remove “${activeDoc.name}” and its annotations from this project?`)) return;
                    edit((d) => {
                      d.docs = d.docs.filter((z) => z.id !== activeDoc.id);
                      const hl = new Set(d.highlights.filter((h) => h.docId === activeDoc.id).map((h) => h.id));
                      d.highlights = d.highlights.filter((h) => h.docId !== activeDoc.id);
                      d.docInk = d.docInk.filter((h) => h.docId !== activeDoc.id);
                      d.comments = d.comments.filter((h) => h.docId !== activeDoc.id);
                      d.bookmarks = d.bookmarks.filter((h) => h.docId !== activeDoc.id);
                      d.links = d.links.filter((l) => !(l.a.kind === 'hl' && hl.has(l.a.id)) && !(l.b.kind === 'hl' && hl.has(l.b.id)));
                    });
                    setUI({ openDocs: [] });
                  }}>Remove from project</button>}
                </Menu>
              )}
              <div className="doc-body">
                <DocRail docId={activeDocId} />
                <div className="doc-columns">
                  {openDocs.map((id) => (
                    <DocView key={id} docId={id} width={openDocs.length > 1 ? (docW - 4) / 2 : docW} />
                  ))}
                </div>
                {panel === 'pages' && <PagesPanel docId={activeDocId} />}
                {panel === 'outline' && <OutlinePanel docId={activeDocId} />}
                {panel === 'annotations' && <AnnotationsPanel />}
              </div>
            </>
          ) : (
            <div className="doc-empty">
              <p>No document in this project yet.</p>
              <button className="primary" onClick={() => setUI({ modal: { kind: 'addDoc' } })}>Add a document</button>
            </div>
          )}
        </section>
        <div
          className="divider"
          onPointerDown={(e) => {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            divRef.current = { x0: e.clientX, r0: ratio, t: Date.now() };
          }}
          onPointerMove={(e) => {
            const d = divRef.current;
            if (!d) return;
            const r = Math.max(0.02, Math.min(0.98, d.r0 + (e.clientX - d.x0) / mainW));
            setUI({ docRatio: r });
          }}
          onPointerUp={(e) => {
            const d = divRef.current;
            divRef.current = null;
            if (d && Math.abs(e.clientX - d.x0) < 4) {
              const now = Date.now();
              if (now - lastDivTap.current < 350) setUI({ docRatio: ratio > 0.9 ? 0.45 : ratio < 0.1 ? 0.45 : 0.98 });
              lastDivTap.current = now;
            }
          }}
        >
          <div className="divider-knob">{I.chevL}{I.chevR}</div>
        </div>
        <section className="ws-wrap" style={{ width: wsW }}>
          <WsBar />
          <Workspace />
          <WsRail />
          <SearchPanel />
        </section>
      </div>

      <LinkOverlay />
      <svg className="live-ink" ref={mountLiveLayer} />
      {drag && (
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>
          {drag.text.slice(0, 220)}
          {drag.text.length > 220 ? '…' : ''}
        </div>
      )}
      {linkFrom && (
        <div className="link-banner">
          Tap a highlight, card, comment or place in a document to link it
          <button onClick={() => setUI({ linkFrom: null })}>Cancel</button>
        </div>
      )}
      <Popovers />
      {modal?.kind === 'addDoc' && <AddDocModal />}
      {modal?.kind === 'help' && <HelpModal />}
      {modal?.kind === 'settings' && <SettingsModal />}
      <HoverCursor />
    </div>
  );
}

function ToolDot({ tool }: { tool: 'pen' | 'highlighter' }) {
  const c = useApp((s) => (tool === 'pen' ? s.settings.penColor : s.settings.hlInkColor));
  return <span className="tool-dot" style={{ background: c }} />;
}

function ToolPalette({ tool, onClose }: { tool: Tool; onClose: () => void }) {
  const st = useApp((s) => s.settings);
  const set = useApp((s) => s.setSettings);
  return (
    <Menu onClose={onClose} style={{ left: '50%', top: 56, transform: 'translateX(-50%)' }} className="palette">
      {tool === 'pen' && (
        <>
          <div className="pal-row">
            {PEN_COLORS.map((c) => (
              <button key={c} className={`swatch ${st.penColor === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set({ penColor: c })} />
            ))}
            <label className="swatch rainbow"><input type="color" value={st.penColor} onChange={(e) => set({ penColor: e.target.value })} /></label>
          </div>
          <div className="pal-row widths">
            {[1, 1.6, 2.5, 4, 6, 9].map((w) => (
              <button key={w} className={`width-btn ${st.penWidth === w ? 'on' : ''}`} onClick={() => set({ penWidth: w })}>
                <span style={{ width: w * 2.4 + 2, height: w * 2.4 + 2, background: st.penColor }} />
              </button>
            ))}
          </div>
          <div className="pal-row presets">
            <span className="hint">Favorites</span>
            {st.penPresets.map((p, i) => (
              <button key={i} className="preset" onClick={() => set({ penColor: p.color, penWidth: p.width })}>
                <span style={{ background: p.color, height: p.width * 2 + 2 }} />
              </button>
            ))}
            <button className="preset add" onClick={() => set({ penPresets: [...st.penPresets.slice(-5), { color: st.penColor, width: st.penWidth }] })}>+</button>
          </div>
        </>
      )}
      {tool === 'highlighter' && (
        <>
          <div className="pal-row">
            {HL_COLORS.map((c) => (
              <button key={c} className={`swatch ${st.hlInkColor === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set({ hlInkColor: c, hlColor: c })} />
            ))}
          </div>
          <div className="pal-row widths">
            {[8, 14, 20, 28].map((w) => (
              <button key={w} className={`width-btn ${st.hlInkWidth === w ? 'on' : ''}`} onClick={() => set({ hlInkWidth: w })}>
                <span style={{ width: 26, height: w / 1.6, borderRadius: 3, background: st.hlInkColor, opacity: 0.6 }} />
              </button>
            ))}
          </div>
          <div className="hint pad">Drag across text to highlight it; draw elsewhere for a free-form marker.</div>
        </>
      )}
      {tool === 'eraser' && (
        <div className="pal-row seg-ctl">
          <button className={st.eraserMode === 'stroke' ? 'on' : ''} onClick={() => set({ eraserMode: 'stroke' })}>Whole stroke</button>
          <button className={st.eraserMode === 'point' ? 'on' : ''} onClick={() => set({ eraserMode: 'point' })}>Partial (pixel)</button>
        </div>
      )}
      {tool === 'lasso' && <div className="hint pad">Circle ink, cards or a region of a document. Drag the selection to move it, or use the menu to excerpt / highlight / delete.</div>}
    </Menu>
  );
}

function DocRail({ docId }: { docId: string }) {
  const collapsed = useUI((s) => !!s.collapsed[docId]);
  const folds = useApp((s) => s.project!.data.folds[docId]?.length ?? 0);
  const panel = useUI((s) => s.panel);
  const open = useUI((s) => s.docRailOpen);
  if (!open)
    return (
      <div className="rail left mini no-doc-gesture">
        <button className="icon-btn small" onClick={() => setUI({ docRailOpen: true })}>{I.chevR}</button>
      </div>
    );
  return (
    <div className="rail left no-doc-gesture">
      <button
        className={`icon-btn ${collapsed || folds ? 'active-soft' : ''}`}
        title="Collapse document to annotations (or pinch vertically)"
        onClick={() => {
          if (folds) {
            edit((d) => { d.folds[docId] = []; });
            setUI({ collapsed: { ...ui().collapsed, [docId]: false } });
          } else setUI({ collapsed: { ...ui().collapsed, [docId]: !collapsed } });
        }}
      >{I.collapse}</button>
      <button className={`icon-btn ${panel === 'outline' ? 'active-soft' : ''}`} title="Contents & bookmarks" onClick={() => setUI({ panel: panel === 'outline' ? null : 'outline' })}>{I.outline}</button>
      <button className={`icon-btn ${panel === 'pages' ? 'active-soft' : ''}`} title="Pages" onClick={() => setUI({ panel: panel === 'pages' ? null : 'pages' })}>{I.pages}</button>
      <button className="icon-btn" title="Add document" onClick={() => setUI({ modal: { kind: 'addDoc' } })}>{I.addDoc}</button>
      <button className="icon-btn" title="Bookmark this spot" onClick={() => {
        const e = currentNavEntry();
        if (!e) return;
        const page = Math.floor(e.u);
        const name = prompt('Bookmark name', `Page ${page + 1}`);
        if (name == null) return;
        const H = loadedFor(docId)?.pages[page]?.height ?? 792;
        edit((d) => { d.bookmarks.push({ id: uid(), docId, page, y: Math.max(0, (e.u - page) * H + 30), name }); });
        useApp.getState().showToast('Bookmarked');
      }}>{I.bookmark}</button>
      <button className={`icon-btn ${panel === 'annotations' ? 'active-soft' : ''}`} title="Annotations list" onClick={() => setUI({ panel: panel === 'annotations' ? null : 'annotations' })}>{I.annotations}</button>
      <button className="icon-btn small" title="Hide" onClick={() => setUI({ docRailOpen: false })}>{I.chevL}</button>
    </div>
  );
}

function WsRail() {
  const open = useUI((s) => s.wsRailOpen);
  const fire = (a: string) => window.dispatchEvent(new CustomEvent('ws-action', { detail: a }));
  if (!open)
    return (
      <div className="rail right mini no-ws-gesture">
        <button className="icon-btn small" onClick={() => setUI({ wsRailOpen: true })}>{I.chevL}</button>
      </div>
    );
  return (
    <div className="rail right no-ws-gesture" onPointerDown={(e) => e.stopPropagation()}>
      <button className="icon-btn" title="New note" onClick={() => createNote()}>{I.addNote}</button>
      <button className="icon-btn" title="Zoom in" onClick={() => fire('zoomIn')}>{I.zoomIn}</button>
      <button className="icon-btn" title="Zoom out" onClick={() => fire('zoomOut')}>{I.zoomOut}</button>
      <button className="icon-btn" title="Fit everything" onClick={() => fire('fit')}>{I.fit}</button>
      <button className="icon-btn small" title="Hide" onClick={() => setUI({ wsRailOpen: false })}>{I.chevR}</button>
    </div>
  );
}

function WsBar() {
  const d = useApp((s) => s.project!.data);
  const [open, setOpen] = useState(false);
  const ws = d.workspaces.find((w) => w.id === d.activeWs) ?? d.workspaces[0];
  return (
    <div className="ws-bar no-ws-gesture" onPointerDown={(e) => e.stopPropagation()}>
      <button className="ws-chip" onClick={() => setOpen(!open)}>{I.layers}<span>{ws.name}</span><span className="chev">▾</span></button>
      {open && (
        <Menu onClose={() => setOpen(false)} style={{ left: 0, top: 36 }}>
          {d.workspaces.map((w) => (
            <button key={w.id} className={w.id === ws.id ? 'on' : ''} onClick={() => {
              useApp.getState().editSilent((dd) => void (dd.activeWs = w.id));
              setUI({ wsSel: [], wsInkSel: [], popover: null });
              setOpen(false);
            }}>{w.name} <small>{w.items.length} items</small></button>
          ))}
          <hr />
          <button onClick={() => {
            const id = uid();
            edit((dd) => {
              dd.workspaces.push({ id, name: `Workspace ${dd.workspaces.length + 1}`, items: [], ink: [], view: { x: 0, y: 0, zoom: 1 } });
              dd.activeWs = id;
            });
            setOpen(false);
          }}>+ New workspace</button>
          <button onClick={() => {
            const n = prompt('Rename workspace', ws.name);
            if (n) edit((dd) => { const w = dd.workspaces.find((x) => x.id === ws.id); if (w) w.name = n; });
            setOpen(false);
          }}>Rename “{ws.name}”…</button>
          <button onClick={() => {
            const id = uid();
            edit((dd) => {
              const src = dd.workspaces.find((x) => x.id === ws.id)!;
              const copy = JSON.parse(JSON.stringify(src));
              const map: Record<string, string> = {};
              for (const it of copy.items) { map[it.id] = uid(); }
              for (const it of copy.items) { it.id = map[it.id]; if (it.dockedTo) it.dockedTo = map[it.dockedTo]; }
              for (const s of copy.ink) s.id = uid();
              dd.workspaces.push({ ...copy, id, name: src.name + ' copy' });
              dd.activeWs = id;
            });
            setOpen(false);
          }}>Duplicate workspace</button>
          {d.workspaces.length > 1 && <button className="danger" onClick={() => {
            if (!confirm(`Delete workspace “${ws.name}”?`)) return;
            edit((dd) => {
              const ids = new Set(dd.workspaces.find((x) => x.id === ws.id)!.items.map((i) => i.id));
              dd.workspaces = dd.workspaces.filter((x) => x.id !== ws.id);
              dd.activeWs = dd.workspaces[0].id;
              dd.links = dd.links.filter((l) => !(l.a.kind === 'item' && ids.has(l.a.id)) && !(l.b.kind === 'item' && ids.has(l.b.id)));
              dd.highlights = dd.highlights.filter((h) => !(h.kind === 'excerpt' && !dd.workspaces.some((w) => w.items.some((i) => i.source?.hlId === h.id))));
            });
            setOpen(false);
          }}>Delete workspace</button>}
        </Menu>
      )}
    </div>
  );
}

/** Apple Pencil hover preview (iPad Pro M2+): shows where the pencil will touch down */
function HoverCursor() {
  const tool = useApp((s) => s.tool);
  const color = useApp((s) => (s.tool === 'highlighter' ? s.settings.hlInkColor : s.settings.penColor));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.pointerType === 'pen' && e.buttons === 0 && (tool === 'pen' || tool === 'highlighter' || tool === 'eraser')) {
        el.style.display = 'block';
        el.style.transform = `translate(${e.clientX - 5}px, ${e.clientY - 5}px)`;
      } else el.style.display = 'none';
    };
    const leave = () => ref.current && (ref.current.style.display = 'none');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerdown', leave);
    window.addEventListener('pointerleave', leave);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', leave);
      window.removeEventListener('pointerleave', leave);
    };
  }, [tool]);
  return <div ref={ref} className="hover-cursor" style={{ borderColor: tool === 'eraser' ? '#888' : color }} />;
}
