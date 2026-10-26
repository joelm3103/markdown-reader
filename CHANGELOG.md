# Changelog

All notable changes to markdown-reader are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); sections are **dated** — newest first,
one section per day the work landed, instead of everything accumulating in one unreleased block.

Two conventions, so an entry is never read as more than it is:

- An entry stays under the date the work **landed**, even where the artifact was revised later;
  any later measurement or rewrite is named inside the entry.
- An entry recorded after the fact **says so**, so a retrospective note cannot be mistaken for a
  same-day record.

A trailing version on a heading (`## [2026-10-19] — v1.0.1`) marks a release that landed that day.
The two release sections below predate this shape and were converted from version-first headings
(`## [1.0.1] — 2026-10-19`) when the 2026-10-26 section was added, on 2026-10-26; every entry was
carried over verbatim by a scripted move, not retyped.

## [2026-10-26]

**In short:**

- Documents now open in tabs, one per file, behind a `View → Tabs` switch that turns the feature off and back to single-document behaviour.
- Each tab keeps its own draft, read-only/editing state, undo history and reading position. Closing a tab asks about that tab; closing the window asks about every unsaved document.
- Selecting a tab checks its file against the disk: an unedited tab reloads silently, and an edited one asks before anything is lost.
- The smoke suite grew `177` → `332` checks, and the hang it hit while this work was verified was traced to Chromium throttling the hidden test window's timers, not to the app.

### Added

- Document tabs, on by default: one tab per open file, in a strip above the panes.
  - `src/settings.js`: new `tabs` preference, default `true`, sanitised like the other keys. Only the preference is persisted — which files were open is session state and is deliberately not restored.
  - `src/index.html`, `src/styles.css`: `#tab-strip` (`role="tablist"`) with one `.tab` per document, a dirty dot, a per-tab close button, and roving tabindex so the strip is one tab stop with `←`/`→`/`Home`/`End` moving inside it and `Delete` closing the focused tab.
  - Per-document state held by `src/renderer.js`: text, saved text, dirty flag, editable flag, CodeMirror state (undo history and selection) and the source/preview reading position.
  - `src/editor.js`: `getState`/`setState`/`resetTo`/`setScrollTop`, so a document's editor state and scroll position can be swapped out and back. `resetTo` never short-circuits on equal text, because two documents can have identical content and must still swap histories.
  - `src/paths.js`: `isSamePath`, comparing normalised, case-insensitive, so a tab is matched to a file the way Windows matches it.
  - Opening a file that is already open **selects its tab** instead of rereading it. Why: a reread replaces the buffer with older bytes and would silently discard unsaved edits.
- `View → Tabs` checkbox (`main.js`), sent to the renderer as a command rather than toggled in the menu, because closing the other documents can be cancelled.
  - `preload.js`: `setTabs` bridge; `main.js` handles `app:set-tabs`, persists the preference and puts the checkbox back in step with what actually happened.
  - Turning tabs off keeps the active document and resolves every other document's unsaved changes first (Save/Discard/Cancel each). A Cancel — or a save that fails — aborts the whole change: tabs stay on and every document stays open, though a document whose prompt was already answered keeps that answer.
  - `app:set-tabs` validates its input and reports a failed write of the preference. `app:settings` ignores the `tabs` key, so the checkbox tracks the value that was written; a write that fails is reported by toast, and the session keeps the new value.
  - With tabs off, opening a file replaces the current one again and asks about unsaved changes first — the behaviour shipped in 1.0.1.
- Selecting a tab checks its file against the disk.
  - An unedited tab reloads silently when the file changed. An edited tab asks **Reload from disk** or **Keep my edits**. Keeping the edits does not ask again for the same disk version, and saving overwrites the disk version, which the prompt says.
  - `src/renderer.js`: `refreshFromDisk` and `resetTabText`. `main.js`: `app:confirm-reload`, whose dismissed answer is Keep my edits, so dismissing the dialog never loses work.
  - Why: a tab holds the text read when it was opened, so a file changed elsewhere would otherwise stay stale, and Save would overwrite the change without warning.
- `scripts/smoke-close-payload.js`: quit-guard payload that scripts the Save/Discard/Cancel answers, so the destructive close paths are covered by the suite instead of needing a human.

### Changed

- `Ctrl+W` closes the active **tab** and selects its neighbour (`Close Tab`), returning to the empty state when the last tab closes. With tabs off the item reads `Close File` again and behaves as before.
  - `main.js`: the File-menu item's label is set by the renderer through `app:set-doc-state`.
- Closing the window asks about every open document, not only the visible one.
  - `main.js`: `docState.anyDirty` mirrors "some tab is dirty" and gates the `close` handler.
- Dropping several files at once opens one tab per file; in single-file mode only the first loadable file opens, as before.
- Each tab keeps its read-only/editing state for as long as it is open. A document still opens read-only the first time, which is the guarantee that mattered; the state no longer resets on every switch.
- `README.md`: documents tabs, the toggle, tab closing, the session-only/no-restore rule, the disk check and the strip's shortcuts; smoke badge `177` → `332`.
- `npm run smoke`: `177` → `332` checks, including tab state isolation, the toggle's cancelled and completed paths, the menu checkbox, the persisted preference, single-file replacement, and a real window close that is refused while dirty and then allowed through.
  - `scripts/smoke-race-payload.js` (new): rapid switching settles on the last request and keeps each draft, two opens of one file make one tab, discarding a background tab shows and saves its saved text, discarding the active document keeps it editable, the disk-change cases, and a failed save refusing the Tabs-off change.
  - The same payload drives two actions at once — a save or a prompt with a tab switch, a close with a navigation — and checks each outcome is about the document it started with. Every phase reports any prompt it did not script.
- The renderer's test hook (`window.__mdr`) is exposed only when `scripts/smoke.js` runs the app. It sets `MDR_TEST=1`, `main.js` passes `--mdr-test`, and `preload.js` reads it. A normal build does not expose the hook, so nothing can replace its unsaved-changes prompt.

### Fixed

- Four asynchronous races, found by a second code review before the branch merged. Each one let work made during a save, a prompt or a navigation land on the wrong document.
  - Saving marked whichever tab was active when the write finished clean, so a switch during the save could clear another document's unsaved-changes dot and its edits were then closed without a prompt. `saveFile` now fixes the document and the text when the save starts, and only the text written becomes saved.
  - `Ctrl+W` closed whichever tab was active when the prompt finished, so a switch during the save closed a different document than the one it asked about. `closeFile` fixes the tab before the first prompt, and asks again when new edits appear while a save is in flight.
  - Turning Tabs off kept the tab that was active when the toggle started, but a switch during the prompts left the newly selected document on screen with no tab of its own. The toggle now shows the kept document again.
  - Closing a tab could still be followed by an in-flight navigation applying that tab, leaving a closed document on screen with no record. `showTab` re-checks the tab is still open after its await, and every removal drops in-flight navigations.
  - `scripts/smoke-race-payload.js`: each race is driven at once and its outcome checked. The checks were shown to be sensitive by putting the pre-fix behaviour back one change at a time in a scratch copy of the code; each one failed its own check.
- `npm run smoke` hung while this entry was being verified: the run stalled for minutes part-way through a payload and had to be killed.
  - Cause: Chromium throttles timers and animation frames in a hidden renderer, and the suite hides the window. Long chains of injected `setTimeout` waits stretch to roughly one wakeup per minute, which reads as a hang rather than slowness. The same mechanism is the likely explanation for the suite's earlier intermittent hangs, though that was not re-tested against the old code.
  - `scripts/smoke.js`: `disable-background-timer-throttling`, `disable-renderer-backgrounding` and `disable-backgrounding-occluded-windows` before app ready, plus `webContents.setBackgroundThrottling(false)` for the window. With them, `time npm run smoke` — build included — reports `real 0m36.902s`; before them, one run was still stuck part-way through when a 7-minute command timeout killed it.
  - `scripts/smoke.js` also removes `main.js`'s `window-all-closed` listener, because the last check closes the real window on purpose and Electron's default `app.quit()` would race the report.

## [2026-10-19] — v1.0.1

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

## [2026-10-18] — v1.0.0

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
