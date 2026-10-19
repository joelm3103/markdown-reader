# Changelog

All notable changes to markdown-reader are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); sections are headed with both the
release version and the day the work landed — newest first, one section per release, instead of
everything accumulating in one unreleased block.

Two conventions, so an entry is never read as more than it is:

- An entry stays under the date the work **landed**, even where the artifact was revised later;
  any later measurement or rewrite is named inside the entry.
- An entry recorded after the fact **says so**, so a retrospective note cannot be mistaken for a
  same-day record.

## [1.0.1] — 2026-10-19

**In short:**

- The rendered preview reads properly again: per-block vertical margins apply instead of collapsing to line-height alone.
- Horizontal rules and the h1/h2 underlines are now clearly lighter than the background.
- The smoke suite measures that spacing from the live DOM, so the regression now fails the suite.

### Changed

- `scripts/smoke.js` and `scripts/smoke-payload.js`: 4 checks added, measuring the live DOM rather than the stylesheet, so a return to the zeroed-margin behaviour fails the suite.
  - Asserts a rendered paragraph's computed `margin-bottom` is non-zero, the heading→text gap is ≥8px, the gap above `hr` is ≥16px, and the rule's relative-luminance delta against the background is >0.06.
  - Suite total measured at **177 passed, 0 failed** with `npm run smoke`.
- `README.md`: smoke-check badge corrected from `173` to `177`.
- `README.md`: portable artifact named in *Portable build* updated from `markdown-reader-1.0.0-win.zip` to `markdown-reader-1.0.1-win.zip`.
- `package.json`, `package-lock.json`: version `1.0.0` → `1.0.1`.

### Fixed

- Preview: restore vertical spacing between blocks and make horizontal rules visible.
  - Cause: `.markdown-body > .md-block > :first-child` and `:last-child` forced `margin-top`/`margin-bottom` to `0`, and `renderMarkdown` wraps **every** top-level block in its own `.md-block`. Those rules therefore matched the single element inside every block and zeroed all vertical margins in the preview.
  - `src/styles.css`: rescoped the two rules to `.md-block:first-child > :first-child` and `.md-block:last-child > :last-child`, so only the container edges lose their outer margin and per-element margins collapse normally through the wrapper.
  - `src/styles.css`: rhythm set to `p`/`ul`/`ol` `1em 0`, headings h1–h6 `1.6em 0 0.8em` (was `1.5em 0 0.6em`) and `hr` `1.75em 0`. Body text stays `15px` at `line-height: 1.7`.
  - `hr` and the h1/h2 underlines were drawn in `--border` (`#32353c`) on the `#1c1d21` background — a relative-luminance delta of ~0.024. Added a `--rule: #565e6e` token (delta ~0.10) and applied it to both.
  - `--border` is unchanged and still used by the window chrome.

## [1.0.0] — 2026-10-18

**In short:**

- First release: a portable Electron markdown reader with a split live preview and read-only-by-default editing.
- One file at a time — no index, no vault scan, no network by default.

### Added

- Initial release. *(Recorded retrospectively from the artifacts and the `v1.0.0` tag; these entries were not written on the day.)*
  - Portable Windows build: `dist/win-unpacked/` plus `dist/markdown-reader-1.0.0-win.zip`. Deliberately no NSIS installer and no self-extracting exe.
  - Three view modes, all rendering the same document: **Split** (`Ctrl+1`, CodeMirror source beside the live preview, scroll-synced both ways), **Source** (`Ctrl+2`, CodeMirror 6 with markdown highlighting) and **Preview** (`Ctrl+3`, never writes).
  - Documents open read-only behind an explicit toggle (`Ctrl+E`). No autosave: `Ctrl+S` only, an unsaved-changes dot, and prompts before discarding. Undo/redo run through CodeMirror's own history, so undo cannot cross a file boundary.
  - One file at a time. No index, no search, no backlinks, no plugins. Opening a folder lists one directory level and never scans the tree.
  - Files open by dialog (`Ctrl+O`, `Ctrl+Shift+O`), folder-tree click, drag-and-drop (resolved through `webUtils.getPathForFile` in `preload.js`) or a path argument.
  - GitHub-flavoured markdown via `marked`: headings, emphasis, strikethrough, links, autolinks, images, ordered/unordered/nested lists, task lists, tables, blockquotes, inline and fenced code, horizontal rules.
  - Fenced code highlighted with `highlight.js` in Preview; an unknown or missing language is left unhighlighted rather than guessed. Rendered HTML sanitised with DOMPurify, and task-list checkboxes reduced to inert decoration.
  - Relative images resolve against the document's folder and are confined to it; remote `https` images are allowed, which means a document containing one makes a network request when rendered.
  - Main process is plain CommonJS; the renderer is bundled by Vite and served over a privileged `app://` scheme, since ES modules are blocked on `file://`.
  - Settings (`markdown-reader-settings.json`: window bounds, last opened folder, last view mode) are written next to the executable when that folder is writable, falling back to Electron's `userData` directory when it is not.
  - `npm run smoke`: end-to-end suite that launches the real app with an isolated settings location and a temporary document folder, then drives the real renderer. 173 checks at this tag.
  - `README.md` with static shields.io badges.
