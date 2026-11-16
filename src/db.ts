// Minimal promise-based IndexedDB wrapper
import type { Folder, ProjectData, ProjectMeta } from './types';

const DB_NAME = 'fluidnotes';
const DB_VERSION = 1;
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['meta', 'data', 'files', 'folders', 'kv']) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const r = fn(s);
        t.oncomplete = () => resolve(r ? (r.result as T) : (undefined as T));
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const get = <T>(store: string, key: string) => tx<T | undefined>(store, 'readonly', (s) => s.get(key));
export const put = (store: string, key: string, val: unknown) => tx<void>(store, 'readwrite', (s) => s.put(val, key));
export const del = (store: string, key: string) => tx<void>(store, 'readwrite', (s) => s.delete(key));
export const all = <T>(store: string) => tx<T[]>(store, 'readonly', (s) => s.getAll());

export interface StoredFile {
  bytes: ArrayBuffer;
  mime: string;
  name: string;
}

export const db = {
  listMeta: () => all<ProjectMeta>('meta'),
  getMeta: (id: string) => get<ProjectMeta>('meta', id),
  putMeta: (m: ProjectMeta) => put('meta', m.id, m),
  getData: (id: string) => get<ProjectData>('data', id),
  putData: (id: string, d: ProjectData) => put('data', id, d),
  getFile: (id: string) => get<StoredFile>('files', id),
  putFile: (id: string, f: StoredFile) => put('files', id, f),
  delFile: (id: string) => del('files', id),
  listFolders: () => all<Folder>('folders'),
  putFolder: (f: Folder) => put('folders', f.id, f),
  delFolder: (id: string) => del('folders', id),
  getKV: <T>(k: string) => get<T>('kv', k),
  putKV: (k: string, v: unknown) => put('kv', k, v),
  async deleteProject(id: string) {
    const data = await get<ProjectData>('data', id);
    if (data) for (const d of data.docs) await del('files', d.fileId);
    await del('data', id);
    await del('meta', id);
  },
};

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch {
    /* ignore */
  }
}
