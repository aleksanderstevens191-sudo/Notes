# FluidNotes

An iPad-first **active reading and note-taking app** with full Apple Pencil support, inspired by the LiquidText workflow:
read a document on the left, pull ideas out into an infinite workspace on the right, and connect everything with ink.

## Install it (free)

1. On your iPad, open **https://aleksanderstevens191-sudo.github.io/Notes/** in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open **FluidNotes** from your Home Screen. It runs full-screen and works offline.

No account needed. Your projects are stored privately on your own device and never uploaded anywhere.
Updates arrive automatically the next time you open the app.
Use **Share → Project file** to back up a project or move it to another device.

## Features

**Documents**
- PDF, Word (.docx), web pages, photos/scans, plain text/Markdown/HTML, and blank pages — all become documents
- Several documents per project, and two documents side by side
- Text selection with Apple Pencil (just drag) or finger (press & hold), word/sentence double/triple-tap, draggable handles
- Highlights in 5 colours + custom colour, underline, strikethrough, tags
- Comments attached to text (shown in the margin, movable into the workspace)
- **Collapse**: pinch vertically to fold away the text between two passages; or collapse the whole document to just your annotations
- Document map strip with annotation & search markers, page thumbnails, table of contents, bookmarks
- Annotation list filtered by type, colour and tag
- PDF page editor: delete, reorder, insert blank pages or pages from files, extract pages to a new document
- OCR for scanned documents (text recognition, downloaded on first use)
- Pinch / ⌘-scroll zoom, dark mode

**Workspace**
- Drag text into the workspace to make **excerpts** that stay linked to their source (tap ◀ to jump back; tap the teal mark in the document to jump to the card)
- Lasso a region of a page to excerpt it as an image
- Notes with rich text (bold, italic, lists, colours, sizes); Apple Pencil Scribble works in every text field
- Stack cards by dropping one on another; unstack by dragging out
- Infinite canvas with pinch-zoom and pan; multiple workspaces per project

**Ink & links**
- Pressure-sensitive pen and highlighter on documents and workspace; colour/width palette and favourites
- Palm rejection: once an Apple Pencil is used, fingers scroll/pan instead of drawing (configurable)
- Apple Pencil hover preview on supported iPads
- Draw a line between any two things (highlight ↔ card, card ↔ card, comment ↔ note, card ↔ spot in a document) to **link** them; tap to follow
- Whole-stroke or partial eraser (erases ink, highlights and links); lasso to select/move/recolour ink and cards

**Search, navigation, sharing**
- Search across all documents and notes; highlight or excerpt every result at once
- Back/forward navigation history, undo/redo
- Export annotated PDF (with comment/highlight summary), workspace as PNG/PDF, Markdown notes summary, print
- Project files to back up or move a project to another device; deep links (“Copy Link”) to highlights and cards
- Library with folders, sorting, list/grid, search, rename/duplicate/move/delete

## Development

```bash
npm install
npm run dev      # http://localhost:5173 (use --host to open from an iPad on the same Wi-Fi)
npm run build    # production build in dist/
```

Pushing to GitHub deploys `dist/` to GitHub Pages via `.github/workflows/deploy.yml`
(enable Pages → Source: GitHub Actions in the repository settings).

Stack: React + TypeScript + Vite, pdf.js (rendering/text), pdf-lib (PDF writing), perfect-freehand (ink), IndexedDB storage.

## License

[MIT](LICENSE) — free to use, modify and share; keep the copyright notice.
