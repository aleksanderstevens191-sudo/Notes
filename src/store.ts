// Application state (zustand + immer) with undo/redo for project edits
import { create } from 'zustand';
import { produce, Draft } from 'immer';
import { nanoid } from 'nanoid';
import { db } from './db';
import type { Folder, Project, ProjectData, ProjectMeta, Tool, DocRef } from './types';
import { pdfPageCount } from './pdf';

export const uid = () => nanoid(10);

export function emptyData(): ProjectData {
  const wsId = uid();
  return {
    docs: [],
    highlights: [],
    docInk: [],
    comments: [],
    bookmarks: [],
    workspaces: [{ id: wsId, name: 'Workspace 1', items: [], ink: [], view: { x: 0, y: 0, zoom: 1 } }],
    activeWs: wsId,
    links: [],
    folds: {},
    tags: [],
  };
}

export interface Settings {
  pencilOnly: 'auto' | 'on' | 'off';
  penColor: string;
  penWidth: number;
  hlInkColor: string;
  hlInkWidth: number;
  eraserMode: 'stroke' | 'point';
  hlColor: string;
  showDotGrid: boolean;
  snapExcerpts: boolean;
  linkByInk: boolean;
  theme: 'light' | 'dark' | 'auto';
  penPresets: { color: string; width: number }[];
}

const defaultSettings: Settings = {
  pencilOnly: 'auto',
  penColor: '#1a3fd6',
  penWidth: 2.5,
  hlInkColor: '#ffe600',
  hlInkWidth: 14,
  eraserMode: 'stroke',
  hlColor: '#ffe600',
  showDotGrid: true,
  snapExcerpts: true,
  linkByInk: true,
  theme: 'light',
  penPresets: [
    { color: '#111111', width: 2 },
    { color: '#d92b2b', width: 2.5 },
    { color: '#1a3fd6', width: 2.5 },
  ],
};

interface AppState {
  ready: boolean;
  route: { name: 'library' } | { name: 'project'; id: string };
  projects: ProjectMeta[];
  folders: Folder[];
  currentFolder: string | null;
  settings: Settings;
  penSeen: boolean;
  toast: string | null;

  // open project
  project: Project | null;
  undo: ProjectData[];
  redo: ProjectData[];
  tool: Tool;
  dirty: boolean;

  init(): Promise<void>;
  refreshLibrary(): Promise<void>;
  setSettings(p: Partial<Settings>): void;
  showToast(msg: string): void;
  createProject(name: string, docs?: { name: string; bytes: ArrayBuffer }[], folderId?: string | null): Promise<string>;
  openProject(id: string): Promise<void>;
  closeProject(): Promise<void>;
  setTool(t: Tool): void;
  /** Apply an undoable mutation to the open project */
  edit(fn: (d: Draft<ProjectData>) => void, opts?: { coalesce?: string }): void;
  /** Mutation without undo entry (view state etc.) */
  editSilent(fn: (d: Draft<ProjectData>) => void): void;
  doUndo(): void;
  doRedo(): void;
  save(): Promise<void>;
  addDocToProject(name: string, bytes: ArrayBuffer): Promise<DocRef>;
  renameProject(id: string, name: string): Promise<void>;
  deleteProjects(ids: string[]): Promise<void>;
  duplicateProject(id: string): Promise<void>;
  moveProjects(ids: string[], folderId: string | null): Promise<void>;
  createFolder(name: string): Promise<void>;
  renameFolder(id: string, name: string): Promise<void>;
  deleteFolder(id: string): Promise<void>;
  setThumb(thumb: string): void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastCoalesce: { key: string; t: number } | null = null;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  route: { name: 'library' },
  projects: [],
  folders: [],
  currentFolder: null,
  settings: defaultSettings,
  penSeen: false,
  toast: null,
  project: null,
  undo: [],
  redo: [],
  tool: 'select',
  dirty: false,

  async init() {
    const s = await db.getKV<Partial<Settings>>('settings');
    if (s) set({ settings: { ...defaultSettings, ...s } });
    await get().refreshLibrary();
    const seeded = await db.getKV<boolean>('seeded');
    if (!seeded) {
      await db.putKV('seeded', true);
      try {
        const { createSampleProject } = await import('./sample');
        await createSampleProject();
      } catch (e) {
        console.error(e);
      }
      await get().refreshLibrary();
    }
    // restore last open project
    const last = await db.getKV<string>('lastOpen');
    set({ ready: true });
    if (last && get().projects.some((p) => p.id === last)) await get().openProject(last);
  },

  async refreshLibrary() {
    const [projects, folders] = await Promise.all([db.listMeta(), db.listFolders()]);
    set({ projects, folders });
  },

  setSettings(p) {
    const settings = { ...get().settings, ...p };
    set({ settings });
    db.putKV('settings', settings);
  },

  showToast(msg) {
    set({ toast: msg });
    setTimeout(() => {
      if (get().toast === msg) set({ toast: null });
    }, 2600);
  },

  async createProject(name, docs = [], folderId = get().currentFolder) {
    const id = uid();
    const now = Date.now();
    const data = emptyData();
    let size = 0;
    for (const d of docs) {
      const fileId = uid();
      await db.putFile(fileId, { bytes: d.bytes, mime: 'application/pdf', name: d.name });
      const pageCount = await pdfPageCount(d.bytes);
      data.docs.push({ id: uid(), name: d.name, fileId, pageCount });
      size += d.bytes.byteLength;
    }
    const meta: ProjectMeta = { id, name, folderId, createdAt: now, updatedAt: now, size };
    await db.putData(id, data);
    await db.putMeta(meta);
    await get().refreshLibrary();
    return id;
  },

  async openProject(id) {
    const [meta, data] = await Promise.all([db.getMeta(id), db.getData(id)]);
    if (!meta || !data) return;
    // migrate
    const d: ProjectData = { ...emptyData(), ...data };
    if (!d.workspaces.length) d.workspaces = emptyData().workspaces;
    if (!d.workspaces.some((w) => w.id === d.activeWs)) d.activeWs = d.workspaces[0].id;
    set({ project: { meta, data: d }, undo: [], redo: [], route: { name: 'project', id }, tool: 'select', dirty: false });
    db.putKV('lastOpen', id);
  },

  async closeProject() {
    await get().save();
    set({ project: null, route: { name: 'library' }, undo: [], redo: [] });
    db.putKV('lastOpen', null);
    await get().refreshLibrary();
  },

  setTool(t) {
    set({ tool: t });
  },

  edit(fn, opts) {
    const p = get().project;
    if (!p) return;
    const next = produce(p.data, fn);
    if (next === p.data) return;
    const now = Date.now();
    const coalesce = opts?.coalesce && lastCoalesce && lastCoalesce.key === opts.coalesce && now - lastCoalesce.t < 1500;
    lastCoalesce = opts?.coalesce ? { key: opts.coalesce, t: now } : null;
    set({
      project: { ...p, data: next },
      undo: coalesce ? get().undo : [...get().undo.slice(-150), p.data],
      redo: [],
      dirty: true,
    });
    scheduleSave();
  },

  editSilent(fn) {
    const p = get().project;
    if (!p) return;
    const next = produce(p.data, fn);
    if (next === p.data) return;
    set({ project: { ...p, data: next }, dirty: true });
    scheduleSave();
  },

  doUndo() {
    const { project, undo, redo } = get();
    if (!project || !undo.length) return;
    const prev = undo[undo.length - 1];
    set({ project: { ...project, data: prev }, undo: undo.slice(0, -1), redo: [...redo, project.data], dirty: true });
    lastCoalesce = null;
    scheduleSave();
  },

  doRedo() {
    const { project, undo, redo } = get();
    if (!project || !redo.length) return;
    const nxt = redo[redo.length - 1];
    set({ project: { ...project, data: nxt }, redo: redo.slice(0, -1), undo: [...undo, project.data], dirty: true });
    scheduleSave();
  },

  async save() {
    const p = get().project;
    if (!p || !get().dirty) return;
    const meta = { ...p.meta, updatedAt: Date.now() };
    set({ dirty: false, project: { ...p, meta } });
    await db.putData(meta.id, p.data);
    await db.putMeta(meta);
  },

  async addDocToProject(name, bytes) {
    const fileId = uid();
    await db.putFile(fileId, { bytes, mime: 'application/pdf', name });
    const pageCount = await pdfPageCount(bytes);
    const doc: DocRef = { id: uid(), name, fileId, pageCount };
    get().edit((d) => {
      d.docs.push(doc);
    });
    const p = get().project;
    if (p) set({ project: { ...p, meta: { ...p.meta, size: p.meta.size + bytes.byteLength } } });
    await get().save();
    return doc;
  },

  async renameProject(id, name) {
    const m = await db.getMeta(id);
    if (!m) return;
    await db.putMeta({ ...m, name, updatedAt: Date.now() });
    const p = get().project;
    if (p && p.meta.id === id) set({ project: { ...p, meta: { ...p.meta, name } } });
    await get().refreshLibrary();
  },

  async deleteProjects(ids) {
    for (const id of ids) await db.deleteProject(id);
    await get().refreshLibrary();
  },

  async duplicateProject(id) {
    const [m, d] = await Promise.all([db.getMeta(id), db.getData(id)]);
    if (!m || !d) return;
    const nid = uid();
    const data: ProjectData = JSON.parse(JSON.stringify(d));
    for (const doc of data.docs) {
      const f = await db.getFile(doc.fileId);
      const fid = uid();
      if (f) await db.putFile(fid, f);
      doc.fileId = fid;
    }
    await db.putData(nid, data);
    await db.putMeta({ ...m, id: nid, name: m.name + ' copy', createdAt: Date.now(), updatedAt: Date.now() });
    await get().refreshLibrary();
  },

  async moveProjects(ids, folderId) {
    for (const id of ids) {
      const m = await db.getMeta(id);
      if (m) await db.putMeta({ ...m, folderId });
    }
    await get().refreshLibrary();
  },

  async createFolder(name) {
    await db.putFolder({ id: uid(), name, parentId: get().currentFolder, createdAt: Date.now() });
    await get().refreshLibrary();
  },

  async renameFolder(id, name) {
    const f = get().folders.find((x) => x.id === id);
    if (f) await db.putFolder({ ...f, name });
    await get().refreshLibrary();
  },

  async deleteFolder(id) {
    const f = get().folders.find((x) => x.id === id);
    // move children up
    for (const p of get().projects.filter((p) => p.folderId === id)) await db.putMeta({ ...p, folderId: f?.parentId ?? null });
    for (const sub of get().folders.filter((x) => x.parentId === id)) await db.putFolder({ ...sub, parentId: f?.parentId ?? null });
    await db.delFolder(id);
    await get().refreshLibrary();
  },

  setThumb(thumb) {
    const p = get().project;
    if (!p) return;
    const meta = { ...p.meta, thumb };
    set({ project: { ...p, meta } });
    db.putMeta(meta);
  },
}));

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    useApp.getState().save();
  }, 800);
}

// Save when app is backgrounded (iPad multitasking / home)
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') useApp.getState().save();
  });
  window.addEventListener('pagehide', () => useApp.getState().save());
}

export const useData = <T,>(sel: (d: ProjectData) => T): T => useApp((s) => sel(s.project!.data));

if (typeof window !== 'undefined') (window as any).__app = useApp;
