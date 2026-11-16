import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { setUI } from '../ui';
import { I } from './Icons';
import { pickFiles, anyFileToPdf, webpageToPdf, textToPdf, imagesToPdf, blocksToPdf } from '../importers';

export function Menu({ children, onClose, style, className = '' }: { children: React.ReactNode; onClose: () => void; style?: React.CSSProperties; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const fn = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => window.addEventListener('pointerdown', fn, true), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', fn, true);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className={`menu ${className}`}
      style={style}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button') && !className.includes('palette')) setTimeout(onClose, 0);
      }}
    >
      {children}
    </div>
  );
}

export function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <b>{title}</b>
          <span className="grow" />
          <button className="icon-btn" onClick={onClose}>{I.close}</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Busy({ text }: { text: string }) {
  return (
    <div className="busy">
      <div className="spinner" />
      {text}
    </div>
  );
}

/** Chooser for bringing new material into a project (or a new project when target = 'new') */
export function ImportChooser({ onDocs, onCancel }: { onDocs: (docs: { name: string; bytes: ArrayBuffer }[]) => Promise<void> | void; onCancel: () => void }) {
  const [mode, setMode] = useState<null | 'web' | 'text'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<{ name: string; bytes: ArrayBuffer }[]>) => {
    setErr(null);
    setBusy(label);
    try {
      const docs = await fn();
      if (docs.length) await onDocs(docs);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  };

  if (busy) return <Busy text={busy} />;
  if (mode === 'web')
    return (
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          let u = url.trim();
          if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
          run('Loading web page…', async () => [await webpageToPdf(u)]);
        }}
      >
        <label>Web page address</label>
        <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/article" inputMode="url" />
        <p className="hint">The page's article text is converted into a document you can highlight and excerpt. Sites that block direct loading are fetched through the r.jina.ai reader service. You can also paste text instead.</p>
        {err && <p className="error">{err}</p>}
        <div className="row">
          <button type="button" onClick={() => setMode(null)}>Back</button>
          <span className="grow" />
          <button className="primary" type="submit" disabled={!url.trim()}>Open</button>
        </div>
      </form>
    );
  if (mode === 'text')
    return (
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          run('Creating document…', async () => [{ name: title || 'Pasted text', bytes: await textToPdf(title || 'Pasted text', text) }]);
        }}
      >
        <label>Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" />
        <label>Text (paste, type, or write with Apple Pencil Scribble)</label>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} placeholder="Paste text here… Use # for headings and - for bullets." />
        <div className="row">
          <button type="button" onClick={() => setMode(null)}>Back</button>
          <span className="grow" />
          <button className="primary" type="submit" disabled={!text.trim()}>Create</button>
        </div>
      </form>
    );
  return (
    <div className="chooser">
      <button onClick={() => run('Importing…', async () => {
        const files = await pickFiles('application/pdf,.pdf,image/*,.txt,.md,.html,.htm,.docx,text/plain', true);
        const out = [];
        for (const f of files) out.push(await anyFileToPdf(f));
        return out;
      })}>
        <span className="big-ico">{I.cloud}</span>
        <b>Open file</b>
        <small>PDF, Word (.docx), text, HTML or images — from Files, iCloud Drive, Google Drive…</small>
      </button>
      <button onClick={() => setMode('web')}>
        <span className="big-ico">{I.web}</span>
        <b>Open web page</b>
        <small>Turn an article into a document</small>
      </button>
      <button onClick={() => run('Importing pictures…', async () => {
        const files = await pickFiles('image/*', true);
        if (!files.length) return [];
        return [{ name: files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : 'Pictures', bytes: await imagesToPdf(files) }];
      })}>
        <span className="big-ico">{I.camera}</span>
        <b>Open picture</b>
        <small>Photos become document pages</small>
      </button>
      <button onClick={() => run('Scanning…', async () => {
        const files = await pickFiles('image/*', false, 'environment');
        if (!files.length) return [];
        return [{ name: 'Scan ' + new Date().toLocaleDateString(), bytes: await imagesToPdf(files) }];
      })}>
        <span className="big-ico">{I.camera}</span>
        <b>Scan with camera</b>
        <small>Photograph paper pages</small>
      </button>
      <button onClick={() => setMode('text')}>
        <span className="big-ico">{I.text}</span>
        <b>Paste text</b>
        <small>Create a document from text</small>
      </button>
      <button onClick={() => run('Creating…', async () => [{ name: 'Blank notes', bytes: await blocksToPdf('Notes', []) }])}>
        <span className="big-ico">{I.newProject}</span>
        <b>Blank page</b>
        <small>A blank page to write on</small>
      </button>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <span className="grow" />
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function AddDocModal() {
  const close = () => setUI({ modal: null });
  return (
    <Modal title="Add document to project" onClose={close}>
      <ImportChooser
        onCancel={close}
        onDocs={async (docs) => {
          let last = '';
          for (const d of docs) last = (await useApp.getState().addDocToProject(d.name, d.bytes)).id;
          close();
          if (last) setUI({ openDocs: [last] });
        }}
      />
    </Modal>
  );
}

export function HelpModal() {
  const close = () => setUI({ modal: null });
  return (
    <Modal title="How to use FluidNotes" onClose={close} wide>
      <div className="help">
        <section>
          <h4>Reading & selecting</h4>
          <ul>
            <li><b>Apple Pencil</b> (text tool <span className="kbd">A</span>): drag across text to select it. Double-tap a word / triple-tap a sentence.</li>
            <li><b>Finger</b>: scroll normally. Press & hold on text to select a word, then drag to extend.</li>
            <li>Tap a colour in the menu to <b>highlight</b>; tap a highlight to recolour, comment, excerpt, tag or delete it.</li>
            <li><b>Pinch vertically</b> with two fingers to <b>collapse</b> the text between your fingers — bring distant passages together. Tap the fold to open it again. The collapse button collapses the whole document down to your annotations.</li>
            <li>Pinch horizontally to zoom the document. The strip on the left is a map of the whole document; tap it to jump.</li>
          </ul>
        </section>
        <section>
          <h4>Excerpts & workspace</h4>
          <ul>
            <li><b>Drag selected text</b> into the workspace to create an <b>excerpt</b> (with the pencil just drag; with a finger press-and-hold first). Or tap <i>Excerpt</i> in the menu.</li>
            <li>Tap <b>◀</b> on an excerpt to jump to its source; tap a teal excerpt mark in the document to jump to its card.</li>
            <li>Drop a card on the lower half of another card to <b>stack</b> them. Drag a stacked card out to unstack.</li>
            <li>Double-tap empty workspace (or <span className="kbd">AB+</span>) for a <b>note</b>. Double-tap a card to edit its text. Use multiple workspaces from the chip at the top-left.</li>
            <li>Drag a card onto the document to link it to that spot.</li>
          </ul>
        </section>
        <section>
          <h4>Ink & links</h4>
          <ul>
            <li><b>Pen</b> and <b>highlighter</b> work on documents and the workspace, with pressure and tilt-free smoothing. Tap the active tool again for colours and widths.</li>
            <li>Once an Apple Pencil is used, <b>fingers stop drawing</b> (palm rejection) — change this in Settings.</li>
            <li><b>Draw a line</b> with the pen from one thing to another (highlight → card, card → card, comment → note…) to <b>link</b> them. Tap a link to follow, recolour or delete it.</li>
            <li><b>Eraser</b> removes ink, highlights and links (whole-stroke or partial). <b>Lasso</b> selects ink/cards to move them, or a region of a page to excerpt it as an image.</li>
          </ul>
        </section>
        <section>
          <h4>Organise & share</h4>
          <ul>
            <li>Projects can hold several documents (PDF, Word, web pages, pictures, text). View two side by side with the split button.</li>
            <li><b>Search</b> across all documents and notes; highlight or excerpt every result at once.</li>
            <li>Comments, bookmarks, tags, page thumbnails, table of contents and an annotation list live in the left rail.</li>
            <li><b>Share</b>: annotated PDF, workspace image/PDF, Markdown notes summary, or a project file to move work between devices.</li>
            <li>Keyboard: ⌘Z / ⇧⌘Z undo/redo, ⌘F search, V/P/H/E/L tools, N new note.</li>
          </ul>
        </section>
      </div>
    </Modal>
  );
}

export function SettingsModal() {
  const st = useApp((s) => s.settings);
  const set = useApp((s) => s.setSettings);
  const penSeen = useApp((s) => s.penSeen);
  const close = () => setUI({ modal: null });
  return (
    <Modal title="Settings" onClose={close}>
      <div className="settings">
        <div className="set-row">
          <div>
            <b>Draw with Apple Pencil only</b>
            <small>Auto: fingers draw until a Pencil is detected{penSeen ? ' (Pencil detected ✓)' : ''}.</small>
          </div>
          <div className="seg-ctl">
            {(['auto', 'on', 'off'] as const).map((v) => (
              <button key={v} className={st.pencilOnly === v ? 'on' : ''} onClick={() => set({ pencilOnly: v })}>{v === 'auto' ? 'Auto' : v === 'on' ? 'Pencil only' : 'Fingers too'}</button>
            ))}
          </div>
        </div>
        <Toggle label="Link by drawing a line" sub="A pen line from one object to another creates a link" v={st.linkByInk} on={(v) => set({ linkByInk: v })} />
        <Toggle label="Stack excerpts when dropped together" v={st.snapExcerpts} on={(v) => set({ snapExcerpts: v })} />
        <Toggle label="Dot grid in workspace" v={st.showDotGrid} on={(v) => set({ showDotGrid: v })} />
        <div className="set-row">
          <div><b>Appearance</b></div>
          <div className="seg-ctl">
            {(['light', 'dark', 'auto'] as const).map((v) => (
              <button key={v} className={st.theme === v ? 'on' : ''} onClick={() => set({ theme: v })}>{v[0].toUpperCase() + v.slice(1)}</button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <div><b>Eraser</b></div>
          <div className="seg-ctl">
            <button className={st.eraserMode === 'stroke' ? 'on' : ''} onClick={() => set({ eraserMode: 'stroke' })}>Whole stroke</button>
            <button className={st.eraserMode === 'point' ? 'on' : ''} onClick={() => set({ eraserMode: 'point' })}>Partial</button>
          </div>
        </div>
        <p className="hint">All projects are stored privately on this device. Use Share → Project file to back up or move a project to another device.</p>
      </div>
    </Modal>
  );
}

function Toggle({ label, sub, v, on }: { label: string; sub?: string; v: boolean; on: (v: boolean) => void }) {
  return (
    <div className="set-row">
      <div>
        <b>{label}</b>
        {sub && <small>{sub}</small>}
      </div>
      <button className={`switch ${v ? 'on' : ''}`} onClick={() => on(!v)} aria-pressed={v}><i /></button>
    </div>
  );
}
