// Core data model for FluidNotes

export type Rect = [number, number, number, number]; // x, y, w, h in PDF page units (points, top-left origin)
export type Pt = [number, number, number]; // x, y, pressure

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

export interface ProjectMeta {
  id: string;
  name: string;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  size: number;
  thumb?: string;
}

export interface DocRef {
  id: string;
  name: string;
  fileId: string;
  pageCount: number;
  /** text extracted by OCR for image-only pages, keyed by page index */
  ocr?: Record<number, OcrWord[]>;
}

export interface OcrWord {
  text: string;
  rect: Rect;
}

export interface TextSegment {
  page: number;
  start: number; // char index inclusive
  end: number; // char index exclusive
  rects: Rect[];
}

export interface Highlight {
  id: string;
  docId: string;
  segments: TextSegment[];
  color: string;
  text: string;
  tags: string[];
  /** 'highlight' = user highlight, 'excerpt' = source of an excerpt card, 'comment' = anchor of a comment */
  kind: 'highlight' | 'excerpt' | 'comment' | 'underline' | 'strike';
  createdAt: number;
}

export type InkKind = 'pen' | 'highlighter';

export interface Stroke {
  id: string;
  points: Pt[];
  color: string;
  width: number;
  kind: InkKind;
}

export interface DocStroke extends Stroke {
  docId: string;
  page: number;
}

export interface Comment {
  id: string;
  docId: string;
  page: number;
  x: number;
  y: number;
  text: string;
  hlId?: string;
  createdAt: number;
}

export interface Bookmark {
  id: string;
  docId: string;
  page: number;
  y: number;
  name: string;
}

export interface ExcerptSource {
  docId: string;
  hlId?: string;
  page: number;
  rect?: Rect; // for region (image) excerpts
}

export interface WsItem {
  id: string;
  type: 'excerpt' | 'note' | 'image';
  x: number;
  y: number;
  w: number;
  h?: number; // notes and images have explicit heights; excerpts are auto
  text: string; // plain text (excerpt) or html (note)
  color: string; // accent colour
  fontSize?: number;
  source?: ExcerptSource;
  image?: string; // data url
  /** id of the card this one is docked under (stacked group) */
  dockedTo?: string;
  tags: string[];
  createdAt: number;
}

export interface Workspace {
  id: string;
  name: string;
  items: WsItem[];
  ink: Stroke[];
  view: { x: number; y: number; zoom: number };
}

export type Anchor =
  | { kind: 'item'; wsId: string; id: string }
  | { kind: 'hl'; id: string }
  | { kind: 'comment'; id: string }
  | { kind: 'docpos'; docId: string; page: number; x: number; y: number }
  | { kind: 'wsink'; wsId: string; id: string }
  | { kind: 'docink'; id: string };

export interface Link {
  id: string;
  a: Anchor;
  b: Anchor;
  color: string;
}

/** collapsed (folded) ranges per document, in continuous page coordinates: page + y/pageHeight */
export interface Fold {
  id: string;
  from: number;
  to: number;
}

export interface ProjectData {
  docs: DocRef[];
  highlights: Highlight[];
  docInk: DocStroke[];
  comments: Comment[];
  bookmarks: Bookmark[];
  workspaces: Workspace[];
  activeWs: string;
  links: Link[];
  folds: Record<string, Fold[]>;
  tags: string[];
}

export interface Project {
  meta: ProjectMeta;
  data: ProjectData;
}

export type Tool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'lasso';

export const HL_COLORS = ['#ff4d4d', '#3ddc4b', '#5b6bff', '#ffe600', '#ff3df2'];
export const HL_FILL: Record<string, string> = {
  '#ff4d4d': 'rgba(255,77,77,0.38)',
  '#3ddc4b': 'rgba(61,220,75,0.38)',
  '#5b6bff': 'rgba(91,107,255,0.33)',
  '#ffe600': 'rgba(255,230,0,0.5)',
  '#ff3df2': 'rgba(255,61,242,0.33)',
};
export const PEN_COLORS = ['#111111', '#d92b2b', '#1f9d3a', '#1a3fd6', '#f2b600', '#9b2bd9', '#ff7a00', '#ffffff'];
export const NOTE_COLORS = ['#7fe3e0', '#ffe066', '#ff9aa2', '#b5ead7', '#c7ceea', '#ffd6a5'];

export function hlFill(color: string): string {
  if (HL_FILL[color]) return HL_FILL[color];
  // generic: hex -> rgba .38
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.38)`;
}
