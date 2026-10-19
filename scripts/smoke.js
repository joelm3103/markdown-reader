'use strict'

// Smoke test: runs the real app (main.js) with an isolated settings location and
// a temporary document folder, then drives the real renderer through its test
// hook and asserts the behaviour the plan promises.
//
// Run with:  npm run smoke
//
// The window is created by main.js exactly as it is in normal use. It is hidden
// as soon as it appears, so a brief flash is expected.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const REPO_ROOT = path.join(__dirname, '..')
const FIXTURE = path.join(REPO_ROOT, 'fixtures', 'sample.md')

// Without this, a syntax error or startup failure in the main process raises
// Electron's modal error dialog and the run hangs with no exit code.
function failFast(label, err) {
  console.error(`\nSmoke test ${label}:`, err && err.stack ? err.stack : err)
  try {
    app.exit(1)
  } catch {
    process.exit(1)
  }
}

process.on('uncaughtException', (err) => failFast('crashed', err))
process.on('unhandledRejection', (err) => failFast('had an unhandled rejection', err))

/* --------------------------------------------------------- isolated sandbox */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-smoke-'))
const workDir = path.join(sandbox, 'notes')
const nestedDir = path.join(workDir, 'nested')
fs.mkdirSync(nestedDir, { recursive: true })

// Must happen before main.js is required: it reads settings at module load, and
// this keeps the test out of the user's real settings file.
app.setPath('userData', path.join(sandbox, 'userData'))
fs.mkdirSync(path.join(sandbox, 'userData'), { recursive: true })

const fixtureText = fs.readFileSync(FIXTURE, 'utf8')
const fixtureFile = path.join(workDir, 'sample.md')
fs.writeFileSync(fixtureFile, fixtureText, 'utf8')
fs.writeFileSync(path.join(nestedDir, 'child.md'), '# Child\n', 'utf8')
fs.writeFileSync(path.join(workDir, 'plain.txt'), 'not markdown\n', 'utf8')
fs.writeFileSync(path.join(workDir, 'ignored.bin'), 'binary\n', 'utf8')

// Restore a folder so the tree has something to list, and start in Split.
fs.writeFileSync(
  path.join(sandbox, 'userData', 'markdown-reader-settings.json'),
  JSON.stringify({ lastFolder: workDir, mode: 'split' }, null, 2),
  'utf8'
)

// A markdown file and a folder that live OUTSIDE the opened root, for the
// drag-and-drop regression checks. A dropped item is explicit user consent, so it
// must open even though it is not under the open folder.
const outsideDir = path.join(sandbox, 'outside')
fs.mkdirSync(outsideDir, { recursive: true })
const outsideFile = path.join(outsideDir, 'USAGE.md')
fs.writeFileSync(outsideFile, '# Outside file\n\nOUTSIDE-FILE-MARKER\n', 'utf8')
fs.writeFileSync(path.join(outsideDir, 'sibling.md'), '# Sibling\n', 'utf8')
const binaryFile = path.join(outsideDir, 'notes.bin')
fs.writeFileSync(binaryFile, 'not markdown\n', 'utf8')

// Running the real entry point. It registers the app:// scheme, IPC handlers and
// creates the window on app ready.
require('../main.js')

/* ------------------------------------------------------------ small helpers */

const results = []
let rendererPayload = null

function check(name, passed, detail) {
  results.push({ name, passed: Boolean(passed), detail: detail === undefined ? '' : String(detail) })
}

function checkEqual(name, actual, expected) {
  const passed = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, passed, passed ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function section(title) {
  results.push({ section: title })
}

async function waitFor(predicate, { timeout = 20000, interval = 100, label = 'condition' } = {}) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/* ------------------------------------------------------- checks before boot */

function checkBuildArtifacts() {
  const rendererDir = path.join(REPO_ROOT, 'renderer')
  const assetsDir = path.join(rendererDir, 'assets')

  check('renderer bundle exists (renderer/index.html)', fs.existsSync(path.join(rendererDir, 'index.html')))

  if (!fs.existsSync(path.join(rendererDir, 'index.html')) || !fs.existsSync(assetsDir)) {
    check('renderer assets directory exists', false, 'run npm run build')
    return
  }

  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8')
  const entryMatch = html.match(/assets\/([A-Za-z0-9_.-]+\.js)/)
  check('index.html references a bundled entry script', Boolean(entryMatch))
  if (!entryMatch) return

  const entryFile = entryMatch[1]
  const entrySource = fs.readFileSync(path.join(assetsDir, entryFile), 'utf8')
  const chunkFiles = fs.readdirSync(assetsDir).filter((name) => name.endsWith('.js'))

  check('more than one JavaScript chunk was emitted', chunkFiles.length > 1, `${chunkFiles.length} chunks`)

  // The whole point of the dynamic import was that ProseMirror stayed out of the
  // startup chunk. WYSIWYG has since been removed, so the assertion is now that
  // nothing from it survives anywhere in the build.
  const entryHasProseMirror = entrySource.includes('ProseMirror')
  const anyChunkHasProseMirror = chunkFiles.some((name) =>
    fs.readFileSync(path.join(assetsDir, name), 'utf8').includes('ProseMirror')
  )

  check('entry chunk contains no ProseMirror', !entryHasProseMirror, entryHasProseMirror ? 'found ProseMirror in the entry chunk' : '')
  check('no chunk contains ProseMirror (WYSIWYG fully removed)', !anyChunkHasProseMirror)
  check('no milkdown chunk was emitted', !chunkFiles.some((name) => /milkdown|wysiwyg/i.test(name)), chunkFiles.filter((n) => /milkdown|wysiwyg/i.test(n)).join(','))
  check(
    'entry chunk stays under 1 MB',
    Buffer.byteLength(entrySource, 'utf8') < 1024 * 1024,
    `${Math.round(Buffer.byteLength(entrySource, 'utf8') / 1024)} kB`
  )
}

function checkFsApi() {
  const fsapi = require('../src/fsapi')

  const root = path.join(workDir)
  const scope = { root, files: [] }

  check('allows the root folder itself', fsapi.isPathAllowed(root, scope))
  check('allows a file inside the root', fsapi.isPathAllowed(fixtureFile, scope))
  check('allows a nested file inside the root', fsapi.isPathAllowed(path.join(nestedDir, 'child.md'), scope))

  // The classic escape attempts.
  const escapes = [
    path.join(root, '..', '..', 'Windows', 'System32', 'drivers', 'etc', 'hosts'),
    path.join(root, '..', 'elsewhere.md'),
    'C:\\Windows\\win.ini'
  ]
  for (const candidate of escapes) {
    check(`rejects escape ${path.basename(candidate)}`, !fsapi.isPathAllowed(candidate, scope), candidate)
  }

  // A sibling folder sharing the root's name as a prefix must not be treated as
  // living inside it.
  check(
    'rejects a sibling folder with a matching name prefix',
    !fsapi.isPathAllowed(path.join(sandbox, 'notes-evil', 'x.md'), scope),
    path.join(sandbox, 'notes-evil', 'x.md')
  )

  check('rejects a path outside any scope', !fsapi.isPathAllowed('C:\\Windows\\win.ini', { root: null, files: [] }))
  check('allows an explicitly opened file outside the root', fsapi.isPathAllowed('C:\\Windows\\win.ini', { root: null, files: ['C:\\Windows\\win.ini'] }))

  // Round trip through the real read/write functions.
  const target = path.join(workDir, 'roundtrip.md')
  const written = '# Round trip\n\nüber — émoji ✅\n'
  const saveResult = fsapi.saveFile(target, written)
  check('saveFile reports success', saveResult.ok, saveResult.error || '')
  const readResult = fsapi.readFile(target)
  check('readFile reports success', readResult.ok, readResult.error || '')
  checkEqual('save then read returns identical content', readResult.content, written)

  fs.writeFileSync(path.join(workDir, 'bom.md'), `\uFEFF# BOM\n`, 'utf8')
  checkEqual('readFile strips a UTF-8 BOM', fsapi.readFile(path.join(workDir, 'bom.md')).content, '# BOM\n')

  // Listing is one level only: the nested folder must appear as a directory
  // entry, never as its children.
  const listing = fsapi.listDir(workDir)
  check('listDir succeeds', listing.ok, listing.error || '')
  const names = listing.entries.map((entry) => entry.name)
  checkEqual('listDir is sorted, directories first, non-markdown hidden', names, [
    'nested',
    'bom.md',
    'plain.txt',
    'roundtrip.md',
    'sample.md'
  ])
  check('listDir does not recurse', !names.includes('child.md'))

  const missing = fsapi.listDir(path.join(workDir, 'does-not-exist'))
  check('listDir reports a friendly error for a missing folder', !missing.ok && /no longer exists/i.test(missing.error), missing.error || '')
}

function checkMenuStructure() {
  const { Menu } = require('electron')
  const menu = Menu.getApplicationMenu()
  check('application menu was built', Boolean(menu))
  if (!menu) return

  const save = menu.getMenuItemById('save')
  const closeFile = menu.getMenuItemById('close-file')
  const openFile = menu.getMenuItemById('open-file')
  const openFolder = menu.getMenuItemById('open-folder')

  check('File menu has Open File', Boolean(openFile))
  check('File menu has Open Folder', Boolean(openFolder))
  check('File menu has Save', Boolean(save))
  check('File menu has Close File', Boolean(closeFile))
  checkEqual('Open File accelerator is Ctrl+O', openFile && openFile.accelerator, 'CmdOrCtrl+O')
  checkEqual('Open Folder accelerator is Ctrl+Shift+O', openFolder && openFolder.accelerator, 'CmdOrCtrl+Shift+O')
  checkEqual('Save accelerator is Ctrl+S', save && save.accelerator, 'CmdOrCtrl+S')
  checkEqual('Close File accelerator is Ctrl+W', closeFile && closeFile.accelerator, 'CmdOrCtrl+W')

  // Ctrl+W must not be left to the default window-close behaviour.
  check('Close File is a custom item, not the window close role', closeFile && closeFile.role !== 'close')
}

function checkMenuEnabledState() {
  const { Menu } = require('electron')
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const save = menu.getMenuItemById('save')
  const closeFile = menu.getMenuItemById('close-file')

  // At this point the payload has reopened a clean document, so the menu should
  // reflect: nothing to save, but something to close.
  check('Close File menu item is enabled while a document is open', closeFile && closeFile.enabled === true, `enabled=${closeFile && closeFile.enabled}`)
  check(
    'Save menu item is disabled while the document is clean',
    save && save.enabled === false,
    `save.enabled=${save && save.enabled} rendererDirty=${rendererPayload && rendererPayload.dirtyAfterReopen} rendererHasFile=${rendererPayload && rendererPayload.hasFileAfterReopen}`
  )
}

/* ------------------------------------------------------------ payload checks */

function runPayloadChecks(out) {
  section('renderer: the empty state does not hide the folder tree')
  check('empty state is shown when no file is open', out.emptyStateDisplayedWithNoFile)
  check(
    'empty state starts to the right of the sidebar (does not cover the tree)',
    !out.emptyStateOverlapsSidebar,
    `emptyState.left=${out.emptyStateLeft} sidebar.right=${out.sidebarRight}`
  )
  check('folder tree is visible with no file open', out.treeVisibleWithNoFile)
  check('folder tree already lists the opened folder with no file open', out.treeFileRowsWithNoFile === 4, `rows=${out.treeFileRowsWithNoFile}`)

  section('renderer: preload bridge')
  check('window.mdapi bridge is exposed', out.hasBridge)
  check('preload exposed webUtils.getPathForFile (drag-and-drop path)', out.hasWebUtils)
  checkEqual('getPathForFile is a function', out.getPathForFileType, 'function')

  section('renderer: sanitising hostile markdown')
  check('no script executed (window.__pwned untouched)', out.pwned === 0, `__pwned=${out.pwned}`)
  checkEqual('no <script> element survived', out.hostileHasScriptEl, 0)
  checkEqual('no onerror attribute survived', out.hostileHasOnerror, 0)
  check('safe text around the payload survived', /Safe heading/.test(out.hostileSurvivingText || ''), out.hostileSurvivingText)
  check('surrounding list text survived', /one/.test(out.hostileSurvivingText || ''))
  check('task-list checkboxes survived the sanitizer', out.hostileCheckboxCount >= 2, `count=${out.hostileCheckboxCount}`)
  checkEqual('checkboxes were made inert', out.hostileCheckboxEnabled, 0)
  check('relative image src was rewritten to the app: asset route', /^app:\/\/local\/__file\?p=/.test(out.hostileImgSrc || ''), out.hostileImgSrc)

  section('renderer: code highlighting')
  check('highlight.js token spans were emitted for js', out.codeHasTokenSpan, out.codeHtml)
  check('the keyword token was tagged', out.codeHasHljsKeyWord, out.codeHtml)
  check('highlighted markup was not escaped a second time', out.codeNotDoubleEscaped, out.codeHtml)
  check('a nested fenced block inside a list is highlighted', out.nestedCodeHasTokenSpan)
  check('a fenced block with no language stays untagged', !out.plainCodeHasTokenSpan, out.plainCodeHtml)
  check('a fenced block with no language is still escaped', out.plainCodeEscaped, out.plainCodeHtml)

  section('renderer: line map')
  checkEqual('small document maps to source lines 1, 3, 5', out.smallLines, [1, 3, 5])
  checkEqual('small document block types', out.smallTypes, ['heading', 'paragraph', 'heading'])
  check('small document map is monotonic', out.smallMonotonic)
  check('fixture map is monotonic', out.fixtureMonotonic, JSON.stringify(out.fixtureTypes))
  checkEqual('fixture first block starts at line 1', out.fixtureFirstLine, 1)
  check('fixture produced blocks', out.fixtureBlockCount > 8, `count=${out.fixtureBlockCount}`)
  check('fixture has no definition token rendered as a block', !out.fixtureTypes.includes('def'), JSON.stringify(out.fixtureTypes))

  section('renderer: scroll-sync maths')
  checkEqual('lineToOffset interpolates between anchors (line 2)', out.lineToOffsetMid, 50)
  checkEqual('lineToOffset snaps to an anchor (line 3)', out.lineToOffsetAtAnchor, 100)
  checkEqual('offsetToLine at an anchor returns that anchor line (offset 100)', out.offsetToLineAtAnchor, 3)
  checkEqual('offsetToLine interpolates between anchors (offset 50)', out.offsetToLineMid, 2)
  checkEqual('offsetToLine clamps before the first anchor', out.offsetToLineFirst, 1)
  checkEqual('lineToOffset degrades to 0 without anchors', out.lineToOffsetNoData, 0)

  section('renderer: path resolution')
  checkEqual('resolves ../ against the document folder', out.resolvedSibling, 'C:\\notes\\other\\note.md')
  checkEqual('keeps an absolute target as-is', out.resolvedAbsoluteKept, 'D:\\elsewhere\\x.md')
  checkEqual('dirname handles Windows separators', out.dirnameOf, 'C:\\notes\\a')

  section('renderer: loading a document through IPC')
  check('document loaded', out.loaded === true)
  checkEqual('current document path is tracked', out.stateDocPath, fixtureFile)
  check('document is marked as open', out.stateHasFile === true)
  check('freshly loaded document is not dirty', out.stateDirty === false)
  check('editor received the document', out.editorMatchesFixture, `editor=${out.editorTextLength} chars, file=${out.fixtureTextLength} chars`)
  check('preview rendered blocks', out.domBlockCount > 8, `blocks=${out.domBlockCount}`)
  checkEqual('preview block count matches the line map', out.domBlockCount, out.stateBlockCount)
  check('anchors stayed monotonic after render', out.stateMonotonic)
  check('every wrapper carries its source line', out.wrappersMatchMap, `wrappers=${out.wrapperLines.length} map=${out.mapLines.length}`)
  check('measured block offsets are ascending (anchors usable)', out.offsetsAscending, `${out.offsetCount} offsets`)
  check('preview rendered the heading', out.previewHasHeading)
  check('preview rendered the third level heading', out.previewHasH3)
  check('preview rendered the table', out.previewHasTable)
  check('preview emitted code blocks', out.previewCodeBlockCount >= 3, `blocks=${out.previewCodeBlockCount}`)
  check(
    'preview highlighted the js and python blocks but left the plain one alone',
    out.previewHighlightedBlocks === 2,
    `highlighted=${out.previewHighlightedBlocks} of ${out.previewCodeBlockCount}`
  )
  check('preview is scrollable', out.previewScrollHeight > 0, `scrollHeight=${out.previewScrollHeight}`)

  section('renderer: live render spacing and visible rules')
  check(
    'rendered paragraphs keep their vertical margin (block margins are not zeroed)',
    out.previewParagraphMarginNonZero,
    `margin-bottom=${out.previewParagraphMargin}`
  )
  check(
    'the gap between a heading and the text below it is visible',
    out.headingGapVisible,
    `gap=${out.headingToTextGap}px`
  )
  check('the gap above a horizontal rule is roomy', out.hrGapAboveRoomy, `gap=${out.hrGapAbove}px`)
  check(
    'the horizontal rule stands out against the background',
    out.hrClearlyVisible,
    `luminance delta=${out.hrLuminanceDelta.toFixed(3)}`
  )

  section('renderer: folder tree is lazy and filtered')
  check('tree shows the opened folder', /notes/.test(out.folderName || ''), out.folderName)
  check('the opened folder starts expanded', out.treeDirRows === 2, `dir rows=${out.treeDirRows}`)
  check('tree listed the markdown files in the root', out.treeFileRows === 4, `rows=${out.treeFileRows} labels=${JSON.stringify(out.treeLabels)}`)
  check('tree did not recurse into the nested folder', !out.treeLabels.some((label) => /child/.test(label)), JSON.stringify(out.treeLabels))
  check('tree listed the nested folder as a directory row', out.treeLabels.some((label) => /nested/.test(label)), JSON.stringify(out.treeLabels))

  section('renderer: live editing, dirty state and saving')
  check('document was clean before typing', out.dirtyBeforeTyping === false)
  check('dirty state updates immediately, before the render debounce', out.dirtyImmediatelyAfterTyping === true)
  check('typing through the editor marks the document dirty', out.dirtyAfterTyping === true)
  check('the in-memory text grew', out.textGrew)
  check('the live preview re-rendered new blocks', out.blocksGrew, `before=${out.blocksBeforeEdit} after=${out.blocksAfterEdit}`)
  check('the line map was rebuilt', out.lineMapGrew)
  check('the typed heading appears in the preview', out.previewContainsTypedHeading)
  check('the typed body text appears in the preview', out.previewContainsTypedText)
  check('scroll anchors realigned after the live re-render', out.wrappersMatchMapAfterEdit)
  check('saving through the app reported success', out.saveSucceeded === true)
  check('the document is clean again after saving', out.dirtyAfterSave === false)

  // The real proof that saving works: read the bytes back off the disk.
  // Note these disk reads happen after the payload has finished, so they reflect
  // the LAST write of the run (which contains this text plus later edits). The
  // fixture is only restored at the very end, after every disk assertion.
  const onDisk = fs.readFileSync(fixtureFile, 'utf8')
  check('the saved text is on disk', onDisk.includes('Text typed through the editor pipeline.'))
  check('the saved file still contains the original content', onDisk.startsWith('# markdown-reader fixture'))

  section('renderer: mode switching, with WYSIWYG removed')
  checkEqual('Source mode applied', out.sourceModeAttr, 'source')
  checkEqual('Preview mode applied', out.previewModeAttr, 'preview')
  checkEqual('Split mode applied', out.splitModeAttr, 'split')
  checkEqual('exactly three mode buttons remain', out.modeButtons, ['split', 'source', 'preview'])
  checkEqual('three mode buttons in the toolbar', out.modeButtonCount, 3)
  check('no WYSIWYG pane or Milkdown/ProseMirror node exists in the DOM', out.wysiwygElements === 0, `found ${out.wysiwygElements}`)
  check('selecting the removed mode is ignored', out.setModeToWysiwygRejected === true)
  check('Preview mode rendered the document', out.previewBlocksInPreviewMode > 8, `blocks=${out.previewBlocksInPreviewMode}`)
  check('Split mode shows both source and preview', out.splitHasSourceAndPreview === true)

  // Last disk assertion in the run, so this is where the sandbox fixture goes back.
  fs.writeFileSync(fixtureFile, fixtureText, 'utf8')

  section('renderer: dropping files, including from outside the opened folder')
  check('a dropped file outside the opened folder opens', out.dropOutsideFile === true)
  check('the dropped file became the current document', out.droppedDocPath === out.droppedExpectedPath, `docPath=${out.droppedDocPath}`)
  check('the dropped file is reported as open', out.droppedFileOpened === true)
  check('the dropped file rendered', out.droppedBlocks > 0, `blocks=${out.droppedBlocks}`)
  check('the dropped file content was read', out.droppedTextHasContent === true)
  check('dropping a non-markdown file is refused', out.dropNonMarkdown === false)
  check('a refused drop leaves the open document alone', out.stillOpenAfterBadDrop === true)
  check('a dropped folder becomes the new root', out.dropOutsideFolder === true)
  check('the tree switched to the dropped folder', /outside/.test(out.folderNameAfterDrop || ''), out.folderNameAfterDrop)
  check('the dropped folder was listed', out.treeRowsAfterFolderDrop >= 2, `rows=${out.treeRowsAfterFolderDrop}`)

  section('renderer: the tree follows the dropped document')
  check('dropping a file that belongs to the open tree keeps the tree', out.treeKeptForOwnFolder === true, `rows=${out.treeRowsAfterOwnDrop}`)
  check('the folder name is unchanged for a file in the open folder', /notes/.test(out.folderNameAfterOwnDrop || ''), out.folderNameAfterOwnDrop)
  check('dropping a file from elsewhere clears the stale tree', out.treeRowsAfterOutsideDrop === 0, `rows=${out.treeRowsAfterOutsideDrop}`)
  check('the folder label reset when the tree was cleared', out.folderNameAfterOutsideDrop === 'No folder', out.folderNameAfterOutsideDrop)
  check('the cleared tree shows its empty hint', /Open a folder/.test(out.treeHintAfterOutsideDrop || ''), out.treeHintAfterOutsideDrop)
  check('dropping one file does not adopt its folder as the new root', !/outside/.test(out.folderNameAfterOutsideDrop || ''), out.folderNameAfterOutsideDrop)

  section('renderer: documents open read-only')
  check('a freshly loaded document is not editable', out.readOnlyOnLoad === true)
  checkEqual('the source pane is not contenteditable', out.contentEditableOnLoad, 'false')
  checkEqual('the toolbar shows the read-only indicator', out.editingLabelOnLoad, 'Read-only')
  checkEqual('the read-only indicator carries a lock glyph', out.editingGlyphOnLoad, '🔒')
  checkEqual('the toggle reports itself unpressed', out.editingPressedOnLoad, 'false')
  check('Save is disabled for an untouched read-only document', out.saveDisabledOnLoad === true)

  section('renderer: editing is behind an explicit toggle')
  check('toggling makes the pane editable', out.editableAfterToggle === true)
  checkEqual('the pane becomes contenteditable', out.contentEditableAfterToggle, 'true')
  checkEqual('the toolbar switches to the editing indicator', out.editingLabelAfterToggle, 'Editing')
  check('typing after the toggle marks the document dirty', out.dirtyAfterTypingWhenEditable === true)
  check('the typed text grew the document', out.editedLength > out.originalLength, `${out.originalLength} -> ${out.editedLength}`)
  check('Save becomes enabled once there is something to save', out.saveEnabledAfterTyping === true)

  section('renderer: undo and redo run through the editor history')
  check('undo reported that it did something', out.undoReturned === true)
  check('undo reverted the typed text', out.textRevertedByUndo === true)
  check('undo restored the original length', out.undoRestoredOriginal === true, `len=${out.editedLength} vs original=${out.originalLength}`)
  check('undo cleared the dirty flag', out.dirtyAfterUndo === false)
  check('redo reported that it did something', out.redoReturned === true)
  check('redo reapplied the edit', out.redoReapplied === true)
  check('redo marked the document dirty again', out.dirtyAfterRedo === true)
  check('a second undo returned to a clean document', out.cleanAfterSecondUndo === true)

  section('renderer: history does not leak across files')
  check('reopening a document resets to read-only', out.readOnlyAfterReopen === true)
  checkEqual('the reopened document is not contenteditable', out.contentEditableAfterReopen, 'false')
  check('undo on a freshly opened file has nothing to undo', out.undoReturnedAfterReopen === false, `returned=${out.undoReturnedAfterReopen}`)
  check(
    'undo did not resurrect the previous file content',
    out.textAfterUndoOnFreshFile === out.outsideContent,
    `got ${out.textAfterUndoOnFreshFile && out.textAfterUndoOnFreshFile.length} chars, expected ${out.outsideContent && out.outsideContent.length}`
  )

  section('renderer: Close File keeps the app and the folder tree open')
  check('closeFile reported success', out.closed === true)
  check('the document path was cleared', out.closedDocPath === null, `docPath=${out.closedDocPath}`)
  check('no document is open any more', out.closedHasFile === false)
  check('the closed document is not dirty', out.closedDirty === false)
  check('in-memory text was cleared', out.closedTextLength === 0)
  check('the source editor was cleared', out.closedEditorLength === 0)
  check('the preview was cleared', out.closedPreviewBlocks === 0, `blocks=${out.closedPreviewBlocks}`)
  check('the empty state came back', out.closedNoFileClass === true && out.closedEmptyStateVisible === true)
  check('the empty state still does not cover the sidebar', out.closedEmptyStateOverlapsSidebar === false)
  check('the folder tree survived closing the file', out.closedTreeFileRows === 4, `file rows=${out.closedTreeFileRows}`)
  check('the folder tree still shows the nested directory', out.closedTreeDirRows === 2, `dir rows=${out.closedTreeDirRows}`)
  check('no tree row is marked active', out.closedActiveTreeRows === 0)
  check('Save is disabled with nothing open', out.closedSaveDisabled === true)
  check('Close File is disabled with nothing open', out.closedCloseDisabled === true)
  check('the filename label reset', out.closedFileName === 'No file open', out.closedFileName)
  check('a file can be reopened from the tree after closing', out.reopenedAfterClose === true && out.reopenedHasFile === true)
  check('the reopened file rendered again', out.reopenedBlockCount > 8, `blocks=${out.reopenedBlockCount}`)
}

/* --------------------------------------------------------------- the driver */

async function main() {
  checkBuildArtifacts()
  checkFsApi()

  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], {
    label: 'the application window',
    timeout: 30000
  })

  win.hide()

  await new Promise((resolve) => {
    if (!win.webContents.isLoading()) return resolve()
    win.webContents.once('did-finish-load', resolve)
  })

  // Wait for renderer boot() to finish: the hook is installed synchronously but
  // the folder tree and initial render happen after an await.
  await waitFor(
    () => win.webContents.executeJavaScript('Boolean(window.__mdr && window.__mdr.getState().docPath !== undefined)'),
    { label: 'renderer boot' }
  )

  checkMenuStructure()

  await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector("#tree .tree-row"))'), {
    label: 'the folder tree to list'
  })

  const hostileMarkdown = [
    '# Safe heading',
    '',
    '<img src=x onerror="window.__pwned=1">',
    '',
    '<script>window.__pwned = 2;</script>',
    '',
    '- [x] done one',
    '- [ ] todo two',
    '',
    '![relative](./pic.png)',
    '',
    'Trailing text one two three.'
  ].join('\n')

  await win.webContents.executeJavaScript(
    `window.__smoke = ${JSON.stringify({
      fixtureFile,
      fixtureDir: workDir,
      fixtureText,
      // Level-2 headings already present, so the payload can prove a typed
      // heading actually added one instead of just matching the fixture.
      fixtureH2Count: (fixtureText.match(/^## /gm) || []).length,
      outsideFile,
      outsideDir,
      outsideText: fs.readFileSync(outsideFile, 'utf8'),
      binaryFile,
      hostileMarkdown
    })}; true`
  )

  const payloadSource = fs.readFileSync(path.join(__dirname, 'smoke-payload.js'), 'utf8')
  rendererPayload = await win.webContents.executeJavaScript(payloadSource, true)

  runPayloadChecks(rendererPayload)
  checkMenuEnabledState()
}

/* ------------------------------------------------------------------ reporting */

function report() {
  let passed = 0
  let failed = 0
  const lines = []

  for (const entry of results) {
    if (entry.section) {
      lines.push(`\n${entry.section}`)
      continue
    }
    if (entry.passed) {
      passed += 1
      lines.push(`  PASS  ${entry.name}`)
    } else {
      failed += 1
      lines.push(`  FAIL  ${entry.name}${entry.detail ? `  (${entry.detail})` : ''}`)
    }
  }

  console.log(lines.join('\n'))
  console.log(`\n${passed} passed, ${failed} failed`)

  if (failed > 0) {
    const firstFailure = results.find((entry) => entry.passed === false)
    console.log(`\nFirst failure: ${firstFailure ? firstFailure.name : 'unknown'}`)
  }

  return failed
}

app.whenReady().then(async () => {
  let failureCount = 1
  try {
    await main()
    failureCount = report()
  } catch (err) {
    console.error('\nSmoke test crashed:', err && err.stack ? err.stack : err)
    if (rendererPayload) console.error('Last payload:', JSON.stringify(rendererPayload, null, 2).slice(0, 4000))
    failureCount = 1
  } finally {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true })
    } catch {
      // Temp cleanup is best-effort.
    }
    app.exit(failureCount === 0 ? 0 : 1)
  }
})
