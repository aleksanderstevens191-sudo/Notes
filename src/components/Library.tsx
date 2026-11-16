import React, { useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { I } from './Icons';
import { Modal, ImportChooser, Menu, SettingsModal, Busy } from './Modals';
import { useUI, setUI } from '../ui';
import { pickFiles, anyFileToPdf, webpageToPdf, imagesToPdf } from '../importers';
import { importProjectFile, exportProjectFile } from '../exporter';
import type { ProjectMeta } from '../types';

function fmtSize(n: number) {
  if (n > 1e6) return (n / 1e6).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1e3)) + ' KB';
}
function fmtDate(t: number) {
  const d = new Date(t);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Edited today at ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return 'Edited ' + d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function Library() {
  const projects = useApp((s) => s.projects);
  const folders = useApp((s) => s.folders);
  const currentFolder = useApp((s) => s.currentFolder);
  const modal = useUI((s) => s.modal);
  const [sort, setSort] = useState<'name' | 'date'>('date');
  const [asc, setAsc] = useState(false);
  const [listView, setListView] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ id: string; x: number; y: number } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [webOpen, setWebOpen] = useState(false);

  const visible = useMemo(() => {
    let list = projects.filter((p) => (q ? p.name.toLowerCase().includes(q.toLowerCase()) : (p.folderId ?? null) === currentFolder));
    list = list.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : a.updatedAt - b.updatedAt) * (asc ? 1 : -1));
    return list;
  }, [projects, q, currentFolder, sort, asc]);
  const visFolders = q ? [] : folders.filter((f) => f.parentId === currentFolder).sort((a, b) => a.name.localeCompare(b.name));
  const folder = folders.find((f) => f.id === currentFolder);

  const newFrom = async (label: string, fn: () => Promise<{ name: string; bytes: ArrayBuffer }[]>) => {
    setBusy(label);
    try {
      const docs = await fn();
      if (!docs.length) return;
      const id = await useApp.getState().createProject(docs[0].name, docs);
      await useApp.getState().openProject(id);
    } catch (e: any) {
      alert('Could not import: ' + (e?.message || e));
    } finally {
      setBusy(null);
    }
  };

  const open = (p: ProjectMeta) => {
    if (editing) {
      setSelected((s) => (s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id]));
      return;
    }
    useApp.getState().openProject(p.id);
  };

  const longPress = useRef<ReturnType<typeof setTimeout>>();

  return (
    <div className="library">
      <header className="lib-bar">
        <div className="lib-title">
          {folder ? (
            <button className="crumb" onClick={() => useApp.setState({ currentFolder: folder.parentId })}>{I.back}<span>Back</span></button>
          ) : (
            <span className="app-name">FluidNotes</span>
          )}
        </div>
        <span className="grow" />
        <button className="txt-btn" onClick={() => { setEditing(!editing); setSelected([]); }}>{editing ? 'Done' : 'Edit'}</button>
        <button className="txt-btn" onClick={() => (sort === 'name' ? setAsc(!asc) : (setSort('name'), setAsc(true)))}>{sort === 'name' ? (asc ? '▲' : '▼') : ''} By Name</button>
        <button className="txt-btn" onClick={() => (sort === 'date' ? setAsc(!asc) : (setSort('date'), setAsc(false)))}>{sort === 'date' ? (asc ? '▲' : '▼') : ''} By Date</button>
        <button className="icon-btn light" title={listView ? 'Grid' : 'List'} onClick={() => setListView(!listView)}>{listView ? I.grid : I.list}</button>
        <button className="icon-btn light" title="New folder" onClick={() => {
          const n = prompt('Folder name', 'New Folder');
          if (n) useApp.getState().createFolder(n);
        }}>{I.folderPlus}</button>
        <button className="icon-btn light" title="Search" onClick={() => setSearchOpen(!searchOpen)}>{I.search}</button>
        <button className="icon-btn light" title="More" onClick={() => setMoreOpen(!moreOpen)}>{I.more}</button>
        {moreOpen && (
          <Menu onClose={() => setMoreOpen(false)} style={{ right: 8, top: 54 }}>
            <button onClick={() => setUI({ modal: { kind: 'settings' } })}>Settings…</button>
            <button onClick={async () => {
              const [f] = await pickFiles('.fluidnotes,application/json', false);
              if (!f) return;
              try {
                const id = await importProjectFile(f);
                useApp.getState().openProject(id);
              } catch (e: any) {
                alert(e?.message || e);
              }
            }}>Import project file…</button>
            <button onClick={async () => {
              const { createSampleProject } = await import('../sample');
              await createSampleProject();
              await useApp.getState().refreshLibrary();
            }}>Add sample project</button>
            <button onClick={() => setUI({ modal: { kind: 'about' } })}>About</button>
          </Menu>
        )}
      </header>
      <div className="lib-body">
        <aside className="lib-side">
          <div className="side-title">Open Document</div>
          <button className="side-btn" onClick={() => newFrom('Importing…', async () => {
            const files = await pickFiles('application/pdf,.pdf,image/*,.txt,.md,.html,.htm,.docx,text/plain', true);
            const out = [];
            for (const f of files) out.push(await anyFileToPdf(f));
            return out;
          })}>
            <span className="circle">{I.cloud}</span>OPEN FILE
          </button>
          <button className="side-btn" onClick={() => setWebOpen(true)}>
            <span className="circle">{I.web}</span>OPEN WEBPAGE
          </button>
          <button className="side-btn" onClick={() => newFrom('Importing pictures…', async () => {
            const files = await pickFiles('image/*', true);
            return files.length ? [{ name: files[0].name.replace(/\.[^.]+$/, ''), bytes: await imagesToPdf(files) }] : [];
          })}>
            <span className="circle">{I.camera}</span>OPEN PICTURE
          </button>
          <button className="side-btn" onClick={() => setNewOpen(true)}>
            <span className="circle">{I.puzzle}</span>MORE SOURCES
          </button>
          <div className="side-card">
            <div className="feat">{I.pen}<div><b>Draw anywhere</b><small>Ink on documents & workspace</small></div></div>
            <div className="feat">{I.layers}<div><b>Multiple documents</b><small>in a single project</small></div></div>
            <div className="feat">{I.link}<div><b>Link everything</b><small>draw a line to connect ideas</small></div></div>
          </div>
        </aside>
        <main className="lib-main">
          {searchOpen && (
            <div className="lib-search">
              {I.search}
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects" />
              {q && <button className="icon-btn small" onClick={() => setQ('')}>{I.close}</button>}
            </div>
          )}
          <h2 className="lib-heading">{q ? `Results for “${q}”` : folder ? folder.name : 'Home'}</h2>
          {editing && (
            <div className="edit-bar">
              <span>{selected.length} selected</span>
              <span className="grow" />
              <button disabled={selected.length !== 1} onClick={() => {
                const p = projects.find((x) => x.id === selected[0])!;
                const n = prompt('Rename', p.name);
                if (n) useApp.getState().renameProject(p.id, n);
              }}>Rename</button>
              <button disabled={!selected.length} onClick={async () => { for (const id of selected) await useApp.getState().duplicateProject(id); setSelected([]); }}>Duplicate</button>
              <MoveButton ids={selected} onDone={() => setSelected([])} />
              <button disabled={selected.length !== 1} onClick={() => exportProjectFile(selected[0])}>Export</button>
              <button className="danger" disabled={!selected.length} onClick={async () => {
                if (!confirm(`Delete ${selected.length} project(s)? This cannot be undone.`)) return;
                await useApp.getState().deleteProjects(selected);
                setSelected([]);
              }}>Delete</button>
            </div>
          )}
          <div className={listView ? 'shelf list' : 'shelf'}>
            {!q && (
              <button className="card new-card" onClick={() => setNewOpen(true)}>
                <div className="thumb new">{I.newProject}</div>
                <div className="card-name">New Project</div>
                <div className="card-meta">From a file, web page, picture or text</div>
              </button>
            )}
            {visFolders.map((f) => (
              <button
                key={f.id}
                className="card folder-card"
                onClick={() => useApp.setState({ currentFolder: f.id })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const n = prompt('Rename folder (leave empty to delete)', f.name);
                  if (n === '') { if (confirm('Delete folder? Projects inside move up a level.')) useApp.getState().deleteFolder(f.id); }
                  else if (n) useApp.getState().renameFolder(f.id, n);
                }}
              >
                <div className="thumb folder">{I.folder}</div>
                <div className="card-name">{f.name}</div>
                <div className="card-meta">{projects.filter((p) => p.folderId === f.id).length} projects</div>
              </button>
            ))}
            {visible.map((p) => (
              <button
                key={p.id}
                className={`card ${selected.includes(p.id) ? 'selected' : ''}`}
                onClick={() => open(p)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtx({ id: p.id, x: e.clientX, y: e.clientY });
                }}
                onPointerDown={(e) => {
                  if (e.pointerType !== 'touch') return;
                  const x = e.clientX,
                    y = e.clientY;
                  longPress.current = setTimeout(() => setCtx({ id: p.id, x, y }), 550);
                }}
                onPointerUp={() => clearTimeout(longPress.current)}
                onPointerMove={() => clearTimeout(longPress.current)}
              >
                <div className="thumb">{p.thumb ? <img src={p.thumb} alt="" draggable={false} /> : <div className="thumb-ph">{I.newProject}</div>}</div>
                {editing && <span className={`check ${selected.includes(p.id) ? 'on' : ''}`}>✓</span>}
                <div className="card-name">{p.name}</div>
                <div className="card-meta">{fmtSize(p.size)} | {fmtDate(p.updatedAt)}</div>
              </button>
            ))}
          </div>
          {!visible.length && q && <div className="empty">No projects match.</div>}
        </main>
      </div>
      {ctx && (
        <Menu onClose={() => setCtx(null)} style={{ left: Math.min(ctx.x, window.innerWidth - 230), top: Math.min(ctx.y, window.innerHeight - 260) }}>
          <button onClick={() => useApp.getState().openProject(ctx.id)}>Open</button>
          <button onClick={() => { const p = projects.find((x) => x.id === ctx.id)!; const n = prompt('Rename', p.name); if (n) useApp.getState().renameProject(p.id, n); }}>Rename…</button>
          <button onClick={() => useApp.getState().duplicateProject(ctx.id)}>Duplicate</button>
          <button onClick={() => exportProjectFile(ctx.id)}>Export project file</button>
          {folders.length > 0 && <button onClick={() => { setEditing(true); setSelected([ctx.id]); }}>Move…</button>}
          <button className="danger" onClick={() => { if (confirm('Delete this project?')) useApp.getState().deleteProjects([ctx.id]); }}>Delete</button>
        </Menu>
      )}
      {newOpen && (
        <Modal title="New project" onClose={() => setNewOpen(false)}>
          <ImportChooser
            onCancel={() => setNewOpen(false)}
            onDocs={async (docs) => {
              const id = await useApp.getState().createProject(docs[0].name, docs);
              setNewOpen(false);
              await useApp.getState().openProject(id);
            }}
          />
        </Modal>
      )}
      {webOpen && <WebModal onClose={() => setWebOpen(false)} onOpen={(u) => { setWebOpen(false); newFrom('Loading web page…', async () => [await webpageToPdf(u)]); }} />}
      {busy && <div className="modal-back"><div className="modal small"><Busy text={busy} /></div></div>}
      {modal?.kind === 'settings' && <SettingsModal />}
      {modal?.kind === 'about' && (
        <Modal title="About FluidNotes" onClose={() => setUI({ modal: null })}>
          <p>FluidNotes is an active-reading workspace for iPad and Apple Pencil: highlight, excerpt, collapse, ink and link ideas across documents.</p>
          <p className="hint">Your projects never leave this device unless you share them. Add to Home Screen from Safari's share menu for a full-screen app that works offline.</p>
        </Modal>
      )}
    </div>
  );
}

function WebModal({ onClose, onOpen }: { onClose: () => void; onOpen: (u: string) => void }) {
  const [u, setU] = useState('');
  return (
    <Modal title="Open web page" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); let x = u.trim(); if (!/^https?:\/\//.test(x)) x = 'https://' + x; onOpen(x); }}>
        <label>Address</label>
        <input autoFocus value={u} onChange={(e) => setU(e.target.value)} placeholder="https://…" inputMode="url" />
        <p className="hint">The article text becomes a document you can read, highlight and excerpt. Sites that block direct loading are fetched via the r.jina.ai reader.</p>
        <div className="row"><span className="grow" /><button className="primary" disabled={!u.trim()}>Open</button></div>
      </form>
    </Modal>
  );
}

function MoveButton({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const folders = useApp((s) => s.folders);
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative' }}>
      <button disabled={!ids.length} onClick={() => setOpen(!open)}>Move</button>
      {open && (
        <Menu onClose={() => setOpen(false)} style={{ right: 0, top: 36 }}>
          <button onClick={async () => { await useApp.getState().moveProjects(ids, null); onDone(); }}>Home</button>
          {folders.map((f) => (
            <button key={f.id} onClick={async () => { await useApp.getState().moveProjects(ids, f.id); onDone(); }}>{f.name}</button>
          ))}
        </Menu>
      )}
    </span>
  );
}
