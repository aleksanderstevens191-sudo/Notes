// Transient UI state for the project view (not persisted / not undoable)
import { create } from 'zustand';
import type { Anchor, Rect } from './types';

export interface DocPos {
  page: number;
  idx: number;
}

export interface TextSel {
  docId: string;
  anchor: DocPos;
  focus: DocPos;
}

export interface SearchHit {
  docId: string;
  page: number;
  start: number;
  end: number;
  snippet: string;
  pre: string;
  post: string;
}

export interface WsHit {
  wsId: string;
  itemId: string;
  snippet: string;
}

export type Popover =
  | { kind: 'selection'; x: number; y: number }
  | { kind: 'highlight'; id: string; x: number; y: number }
  | { kind: 'item'; ids: string[]; x: number; y: number }
  | { kind: 'comment'; id: string; x: number; y: number }
  | { kind: 'lassoDoc'; docId: string; page: number; rect: Rect; strokeIds: string[]; x: number; y: number }
  | { kind: 'link'; id: string; x: number; y: number }
  | { kind: 'tags'; target: { type: 'hl' | 'item'; ids: string[] }; x: number; y: number }
  | null;

export interface NavEntry {
  docId: string;
  u: number; // continuous page coordinate of the top of the viewport
}

interface UIState {
  openDocs: string[];
  docRatio: number;
  zoom: Record<string, number>;
  sel: TextSel | null;
  popover: Popover;
  wsSel: string[]; // selected item ids
  wsInkSel: string[];
  search: { open: boolean; query: string; hits: SearchHit[]; wsHits: WsHit[]; active: number; scope: 'all' | 'docs' | 'workspace' };
  panel: null | 'pages' | 'outline' | 'annotations';
  scrollReq: { docId: string; page: number; y: number; flash?: Rect[]; t: number } | null;
  wsFocusReq: { id: string; t: number } | null;
  flashKey: { key: string; t: number } | null;
  collapsed: Record<string, boolean>; // "collapse to annotations" mode per doc
  drag: null | { text: string; x: number; y: number; kind: 'text' | 'image'; image?: string };
  linkFrom: Anchor | null; // link mode: next tap completes link
  nav: { back: NavEntry[]; fwd: NavEntry[] };
  editingItem: string | null;
  modal: null | { kind: string; payload?: any };
  hover: { x: number; y: number; on: boolean } | null;
  wsRailOpen: boolean;
  docRailOpen: boolean;
  activeDoc: string | null;
  set(p: Partial<UIState>): void;
}

export const useUI = create<UIState>((set) => ({
  openDocs: [],
  docRatio: 0.45,
  zoom: {},
  sel: null,
  popover: null,
  wsSel: [],
  wsInkSel: [],
  search: { open: false, query: '', hits: [], wsHits: [], active: -1, scope: 'all' },
  panel: null,
  scrollReq: null,
  wsFocusReq: null,
  flashKey: null,
  collapsed: {},
  drag: null,
  linkFrom: null,
  nav: { back: [], fwd: [] },
  editingItem: null,
  modal: null,
  hover: null,
  wsRailOpen: true,
  docRailOpen: true,
  activeDoc: null,
  set: (p) => set(p),
}));

export const ui = () => useUI.getState();
export const setUI = (p: Partial<UIState>) => useUI.getState().set(p);

export function anchorKey(a: Anchor): string {
  switch (a.kind) {
    case 'item':
      return 'item:' + a.id;
    case 'hl':
      return 'hl:' + a.id;
    case 'comment':
      return 'comment:' + a.id;
    case 'wsink':
      return 'wsink:' + a.id;
    case 'docink':
      return 'docink:' + a.id;
    case 'docpos':
      return `docpos:${a.docId}:${a.page}:${Math.round(a.x)}:${Math.round(a.y)}`;
  }
}

export function flash(key: string) {
  setUI({ flashKey: { key, t: Date.now() } });
}
