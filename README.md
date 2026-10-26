# markdown-reader

<!--
  Static shields.io badges. Deliberately static: this is a private repo, and
  shields.io cannot read package.json or workflow state from a private repo
  without extra setup, so dynamic badges would render as errors.
  The smoke-check count must be updated by hand when the suite changes.
-->
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)
![Electron 44](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![Build: portable folder + zip](https://img.shields.io/badge/build-portable%20folder%20%2B%20zip-blue)
![Smoke checks: 263 passing](https://img.shields.io/badge/smoke%20checks-263%20passing-brightgreen)
![Network: none by default](https://img.shields.io/badge/network-none%20by%20default-lightgrey)

A small, fast Electron app for reading markdown files, with live editing.
Documents open in tabs, and nothing is ever indexed.

Built because Obsidian's vault scan and extension host are a heavy price to pay
when all you want is to read one file.

## What it is not

Not a note-taking app, not a vault, not a knowledge base. There is no index, no
search, no backlinks, no plugins, and no concept of a "workspace". Opening a
folder lists one directory level; it never scans the tree.

## Running it

```bash
npm install
npm start          # builds the renderer, then launches the app
```

`npm start` runs `npm run build` first, so the app always launches against a
current renderer bundle.

Files open **read-only**; press `Ctrl+E` to start editing. See below.

| Command | What it does |
| --- | --- |
| `npm run build` | Bundles the renderer into `renderer/` |
| `npm start` | Build, then launch the app |
| `npm run smoke` | Build, then run the end-to-end smoke test (see below) |
| `npm run package` | Build, then produce the portable artifacts in `dist/` |

You can also launch straight into a file:

```bash
npm start -- fixtures/sample.md
```

## Opening files

- **Open File** (`Ctrl+O`) — pick a markdown file; it opens in a tab.
- **Open Folder** (`Ctrl+Shift+O`) — browse a folder in the sidebar tree. The
  tree reads one level per folder as you expand it; nothing is pre-scanned. The
  sidebar stays usable with no file open, so you can browse a folder and pick a
  file from it without opening anything first.
- **Drag and drop** — drop `.md` files, or a folder, onto the window. Each
dropped file opens in its own tab. Dropping a folder makes it the sidebar root.
Dropping a *file* deliberately does not: if the file belongs to the folder
already listed, the tree stays as it is and the file is highlighted in it; if it
comes from anywhere else, the sidebar is cleared rather than left showing an
unrelated folder. One dropped file never re-points the whole sidebar at a new
folder.
- **Command line** — pass a path as the first argument.

Relative images inside a document resolve against that document's folder. Only
files inside the current document's folder (or the opened folder) can be loaded
that way, so a document cannot pull in arbitrary files from disk. Remote `https`
images are allowed — which means a document containing one will make a network
request when rendered.

## Document tabs

Every open document gets its own tab, so several files can be open at once.

- Opening a file that is already open **selects its tab** instead of reading the
  file again — unsaved edits are never thrown away by "reopening".
- Each tab keeps its own text, unsaved-changes dot, read-only/editing state, undo
  history and reading position. Switching tabs never prompts and never touches
  the file.
- **Close Tab** (`Ctrl+W`) closes the active tab and selects its neighbour. A tab
  with unsaved changes asks **Save / Discard / Cancel** first.
- Quitting the app checks **every** open document for unsaved changes, not just
  the visible one.
- Tabs are **session-only**: only the on/off preference is persisted, never
  which files were open.

Tabs are on by default. **View → Tabs** turns the feature off, which restores
strict single-document behaviour — the tab strip disappears, and opening a file
replaces the current one (asking first when it has unsaved changes). Turning
tabs off while several documents are open keeps the active one and closes the
others, resolving each one's unsaved changes first; cancelling anywhere leaves
tabs on and every document open, though a document whose prompt was already
answered stays saved or discarded.

## The three view modes

Switch with the toolbar or `Ctrl+1`–`Ctrl+3`. All three render from the same
document.

| Mode | Shortcut | Behaviour |
| --- | --- | --- |
| **Split** | `Ctrl+1` | CodeMirror source on the left, live preview on the right, scroll-synced both ways. Drag the divider to resize. |
| **Source** | `Ctrl+2` | CodeMirror only, with markdown syntax highlighting and line numbers. |
| **Preview** | `Ctrl+3` | Rendered output only. Never writes. |

Only the source pane is editable, so nothing you look at can change the file.

## Read-only by default

Documents open **read-only**. The toolbar shows a 🔒 **Read-only** badge, and the
source pane refuses keyboard input — you can still scroll, select and copy freely.

Press **Ctrl+E** (or click the badge) to start editing; it turns into a ✎
**Editing** badge. A newly opened document always starts read-only, so nothing
is editable by accident; a document you already switched to editing keeps that
state for as long as its tab is open.

This exists because a reader gets clicked on, scrolled and nudged, and any stray
keystroke would otherwise silently modify the file and then ask you to save it.
Editing is a deliberate act: opt in, change something, save.

## Saving and closing

There is **no autosave**. Edits are written only when you press `Ctrl+S` or click
**Save**. A dot next to the filename — and on the tab — marks unsaved changes,
and closing a tab or the window prompts before discarding them. The window
close guard looks at **every** open document, so an unsaved edit in a background
tab stops the app from quitting too.

The prompt only ever appears if the document was actually changed — opening a
file read-only and closing it never asks you anything.

**Undo/redo** (`Ctrl+Z` / `Ctrl+Y`) run through CodeMirror's own history rather
than the browser's, so undoing back to the original text clears the unsaved
indicator, and undo can never reach across a file boundary into a previous
document.

**Close Tab** (`Ctrl+W`) closes the active tab and selects its neighbour without
quitting the app; with no tabs left it returns to the start screen. The folder
you opened stays listed in the sidebar, so you can pick the next file straight
away. If that document has unsaved changes it prompts first, exactly like
quitting does. With tabs turned off the same shortcut closes the single open
document.

## Nothing reformats your files

There is no WYSIWYG mode, and no mode that re-serialises a document. **Preview**
never writes, and **Source** saves exactly the bytes you typed — bullets stay as
`-` or `*` as you wrote them, tables keep their original spacing, hard-wrapped
paragraphs stay wrapped, and `[text][ref]` reference links are not rewritten.

A file opened, read, and closed without editing is never touched on disk.
`npm run smoke` asserts that a freshly loaded document is not marked dirty and
that a file can be opened and closed with no write.

## Portable build

```bash
npm run package
```

Produces two things, both install-free:

- `dist/win-unpacked/` — a folder you can copy anywhere and run
  `markdown-reader.exe` from. Fastest cold start.
- `dist/markdown-reader-1.0.1-win.zip` — the same folder, zipped for carrying
  around.

There is deliberately no NSIS installer and no single-file self-extracting exe:
a self-extracting build has to unpack to `%TEMP%` on every launch, which works
against the point of a fast reader.

Settings (`markdown-reader-settings.json`: window bounds, last opened folder,
last view mode, whether document tabs are on) are written **next to the
executable** when that folder is writable, and fall back to Electron's
`userData` directory when it is read-only (Program Files, a locked USB stick).
The portable folder therefore stays portable.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Ctrl+O` / `Ctrl+Shift+O` | Open file / open folder |
| `Ctrl+E` | Toggle read-only / editing |
| `Ctrl+S` | Save |
| `Ctrl+W` | Close the current tab (with tabs off: close the file) |
| `←` `→` / `Home` `End` / `Delete` | In the tab strip: move between tabs / close the focused tab |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo (editor history) |
| `Ctrl+1`–`Ctrl+3` | Split / Source / Preview |
| `Ctrl+B` | Toggle the sidebar |
| `Ctrl+Shift+I` | Developer tools |
| `Ctrl` `+` / `-` / `0` | Zoom in / out / reset |

## Supported markdown

GitHub-flavoured: headings, paragraphs, emphasis, strikethrough, links,
autolinks, images, ordered/unordered/nested lists, task lists, tables,
blockquotes, inline code and fenced code blocks, horizontal rules.

Fenced code is highlighted with highlight.js (the common-languages build) in the
Preview pane. A fence with an unknown or missing language is
left unhighlighted rather than guessed at. The Source pane highlights embedded
code using CodeMirror's language support.

Rendered HTML is sanitised with DOMPurify, and task-list checkboxes are reduced
to inert decoration, so a markdown file containing raw HTML cannot run script.

## Project layout

```
main.js               main process: window, menu, dialogs, IPC, close guard
preload.js            the only bridge the renderer gets (contextBridge)
src/appProtocol.js    serves the renderer over the app:// scheme
src/fsapi.js          listDir / readFile / saveFile / isPathAllowed
src/settings.js       portable-aware settings file
src/linemap.js        source-line anchors and the scroll-sync maths (pure)
src/markdown.js       marked + highlight.js + DOMPurify -> HTML
src/editor.js         CodeMirror 6 source pane
src/renderer.js       document tabs, modes, folder tree, dirty state, drag-drop, scroll sync
src/paths.js          renderer-side path helpers
fixtures/sample.md    exercises every supported element
scripts/smoke.js      end-to-end smoke test
```

Main-process code is plain CommonJS and is not bundled. Everything under `src/`
that the renderer imports is bundled by Vite, which is why the runtime libraries
(`marked`, `dompurify`, CodeMirror, highlight.js) sit in
`devDependencies`: they are compiled into `renderer/`, so electron-builder must
not also ship a second copy of `node_modules` into the portable folder.

Two Electron details worth knowing if you modify this:

- ES modules are blocked over `file://`, so the renderer is served from a
  privileged `app://` scheme (`src/appProtocol.js`) instead.
- `File.path` no longer exists, so drag-and-drop resolves real paths through
  `webUtils.getPathForFile` in `preload.js`. Without it, dropped files silently
  resolve to empty strings.

## Tests

```bash
npm run smoke
```

This launches the actual app with an isolated settings location and a temporary
document folder, then drives the real renderer. It asserts, among other things:

- path safety (`..` escapes and a sibling folder that merely shares a name
  prefix are rejected) and `listDir` staying one level deep;
- hostile markdown is neutralised — a `<script>` and an `onerror` handler are
  removed, checked by inserting the sanitised HTML into the live DOM and
  confirming nothing ran;
- the source-line map is monotonic and matches the rendered block wrappers
  one-for-one, which is what scroll sync depends on;
- typing marks the document dirty immediately, re-renders the preview on a
  debounce, and saving writes real bytes that are read back off the disk;
- documents open read-only (the pane is not `contenteditable`), editing only
  begins after the explicit toggle, and a new document starts read-only again;
- each open tab keeps its own draft, editability, undo history and reading
  position, and opening an already-open file selects its tab rather than
  rereading the file;
- closing a tab and quitting the app prompt for every unsaved document, and a
  Cancel anywhere stops the close (including the real window-close guard);
- turning tabs off keeps the active document, resolves the other documents'
  unsaved changes first, and cancelling leaves tabs on with nothing lost; with
  tabs off, opening another file prompts before replacing the current one;
- undo reverts typing and clears the dirty flag, redo reapplies it, and undo
  cannot resurrect a previous file's content after another file is opened;
- code blocks are genuinely highlighted, while an unlabelled fence is not;
- no WYSIWYG pane, Milkdown or ProseMirror code exists in the DOM or in any
  emitted chunk, and selecting the removed mode is ignored.

Not covered by the smoke test, because they need a human: the real
Save/Discard/Cancel dialog buttons (the test scripts the answers to those
prompts instead), actual mouse drag-and-drop from Explorer, scroll sync feel
while scrolling, and how the app looks.
