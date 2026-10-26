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

// The window is hidden while the tests run, and Chromium throttles timers and
// animation frames in hidden renderers. Long chains of setTimeout waits then
// stretch to one wakeup per minute and the run looks hung — which is what the
// historic intermittent hang in this suite turned out to be. Keep the
// renderer's clock honest instead. Must be set before app ready.
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

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
const childFile = path.join(nestedDir, 'child.md')
const childText = '# Child\n'
fs.writeFileSync(childFile, childText, 'utf8')
fs.writeFileSync(path.join(workDir, 'plain.txt'), 'not markdown\n', 'utf8')
fs.writeFileSync(path.join(workDir, 'ignored.bin'), 'binary\n', 'utf8')

// A document outside both the opened folder and the drop folder: used to prove
// that a brand-new tab starts read-only wherever the file came from.
const freshFile = path.join(sandbox, 'fresh.md')
const freshText = '# Fresh document\n\nFRESH-FILE-MARKER\n'
fs.writeFileSync(freshFile, freshText, 'utf8')

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
const siblingFile = path.join(outsideDir, 'sibling.md')
const siblingText = '# Sibling\n'
fs.writeFileSync(siblingFile, siblingText, 'utf8')
const binaryFile = path.join(outsideDir, 'notes.bin')
fs.writeFileSync(binaryFile, 'not markdown\n', 'utf8')

// A file the race checks change on disk while it is open in a tab. Its contents
// at each stage are fixed here so the renderer side can compare exactly.
const raceFile = path.join(sandbox, 'race.md')
const raceStates = {
  initial: 'RACE-DISK-1\n',
  two: 'RACE-DISK-2\n',
  three: 'RACE-DISK-3\n',
  four: 'RACE-DISK-4\n'
}
fs.writeFileSync(raceFile, raceStates.initial, 'utf8')

const settingsFile = path.join(sandbox, 'userData', 'markdown-reader-settings.json')

function readSettingsFile() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  } catch {
    return null
  }
}

// The renderer test hook is shipped only to runs that set this (see main.js).
process.env.MDR_TEST = '1'

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

// Progress goes to stderr so the stdout report stays exactly the check list.
// When a run hangs (a native dialog nobody clicks, a renderer wait that never
// resolves) the last line here says where.
function progress(message) {
  console.error(`[smoke] ${message}`)
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

function checkSettingsDefaults() {
  const settings = require('../src/settings')

  checkEqual('settings: multi-document tabs default to on', settings.DEFAULTS.tabs, true)
  // The seeded settings file deliberately has no "tabs" key.
  checkEqual('a settings file without the key loads tabs enabled', settings.load().tabs, true)
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
  const tabs = menu.getMenuItemById('tabs')

  check('File menu has Open File', Boolean(openFile))
  check('File menu has Open Folder', Boolean(openFolder))
  check('File menu has Save', Boolean(save))
  check('File menu has Close File', Boolean(closeFile))
  check('View menu has Tabs', Boolean(tabs))
  checkEqual('Tabs is a checkbox item', tabs && tabs.type, 'checkbox')
  check('Tabs starts checked (on by default)', tabs && tabs.checked === true, `checked=${tabs && tabs.checked}`)
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
  checkEqual('the Close item is labelled for tabs', closeFile && closeFile.label, 'Close Tab')
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
  check('the test hook is exposed when MDR_TEST is set', out.testModeFlag === true)
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

  section('renderer: tabs keep documents apart')
  check('tabs are enabled by default', out.tabsEnabledOnStart === true)
  check('the tab strip is visible with one document open', out.tabStripVisibleOneTab === true)
  checkEqual('the strip is a tablist', out.tabStripRole, 'tablist')
  checkEqual('one tab node per open document', out.tabNodeCount, 1)
  checkEqual('every tab carries the tab role', out.tabRoleCount, out.tabNodeCount)
  checkEqual('exactly one tab reports itself selected', out.tabAriaSelectedCount, 1)
  checkEqual('the tab is named after the file', out.tabsAtStart, ['sample.md'])
  checkEqual('the toolbar button says Close Tab', out.closeButtonLabelWithTabs, 'Close Tab')
  check('a second document opened in its own tab', out.openedSecondTab === true)
  checkEqual('two tabs after opening a second file', out.tabsAfterSecond, ['sample.md', 'child.md'])
  check('the new tab became active', /child\.md$/.test(out.activeAfterSecond || ''), out.activeAfterSecond)
  check('switching back selects the first document', /sample\.md$/.test(out.activeAfterSwitchBack || ''), out.activeAfterSwitchBack)
  check('the first tab kept its own text', out.editorKeptFirstDoc === true)
  check('typing marks the tab dirty', out.dirtyAfterDraftA === true)
  checkEqual('only the edited tab is dirty', out.tabDirtyFlagsAfterA, [true, false])
  check('the first tab was switched to editing', out.editableOnFirstTab === true)
  check('the other tab is still read-only', out.editableOnSecondTab === false)
  checkEqual('the other tab shows its own document', out.editorOnSecondTab, out.childText)
  checkEqual('both tabs are dirty after editing both', out.tabDirtyFlagsAfterB, [true, true])
  check('the draft survived switching away and back', out.draftSurvivedSwitch === true)
  check('the draft is still unsaved', out.dirtyBackOnFirst === true)
  check('editability is kept per document', out.editableBackOnFirst === true)
  check('undo reported that it did something', out.undoReturnedOnFirst === true)
  check('undo removed only this document\u2019s draft', out.undoRemovedOwnDraft === true)
  check('undo cleared this document\u2019s dirty flag', out.undoCleanedFirst === true)
  check('the other tab kept its own dirty state', out.otherTabStillDirty === true)

  section('renderer: tabs keep the reading position and never reread an open file')
  checkEqual('the preview was scrolled before switching', out.previewScrollBeforeSwitch, 150)
  checkEqual('the reading position survived switching away and back', out.previewScrollAfterSwitch, out.previewScrollBeforeSwitch)
  checkEqual('no new tab appeared for an already-open file', out.tabsAfterReopen, out.tabsBeforeReopen)
  check('the in-memory draft survived "reopening" the same file', out.reopenDidNotReread === true)
  check('the reopened tab is still dirty', out.reopenKeptDirty === true)

  section('renderer: closing a tab asks about its unsaved changes')
  check('the tab had unsaved changes before closing', out.childDirtyBeforeClose === true)
  check('Cancel keeps the tab open', out.closeTabCancelled === false)
  checkEqual('the tab count is unchanged after Cancel', out.tabsAfterCancelledClose, 2)
  check('the draft is still there after Cancel', out.draftKeptAfterCancelledClose === true)
  check('Discard closes the tab', out.closeTabAfterDiscard === true)
  checkEqual('one tab remains', out.tabsAfterClosedTab, 1)
  checkEqual('the neighbour tab became active', out.activeAfterClosedTab, 'sample.md')

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

  check('dropping several files at once opens them all', out.multiDropResult === true)
  checkEqual('each dropped file got its own tab', out.tabsAfterMultiDrop, ['sample.md', 'USAGE.md', 'sibling.md'])
  check('the last dropped file became active', out.multiDropActiveLast === out.droppedExpectedPath, `active=${out.multiDropActiveLast}`)

  section('renderer: documents open read-only')
  checkEqual('the fresh file opened as the fourth tab', out.tabsAfterFreshOpen, ['sample.md', 'USAGE.md', 'sibling.md', 'fresh.md'])
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

  section('renderer: history stays with its own document')
  check('switching to another open document shows it read-only', out.readOnlyAfterReopen === true)
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

/* ------------------------------------------------- tabs toggle and closing */

/** Sends the exact message the View > Tabs menu item sends. */
async function sendTabsCommand(win, value) {
  progress(`tabs toggle -> ${value}`)
  win.webContents.send('app:command', 'toggle-tabs', value)
  await waitFor(
    () =>
      win.webContents.executeJavaScript(
        `window.__mdr.lastToggle().done && window.__mdr.lastToggle().desired === ${value ? 'true' : 'false'}`
      ),
    { label: `the tabs toggle (${value}) to finish`, timeout: 15000 }
  )
  return win.webContents.executeJavaScript('window.__mdr.lastToggle().ok === true')
}

function tabsSnapshot(win) {
  return win.webContents.executeJavaScript(
    'window.__mdr.getTabs().map((t) => ({ name: t.name, active: t.active, dirty: t.dirty, editable: t.editable }))'
  )
}

function menuTabsItem() {
  const { Menu } = require('electron')
  return Menu.getApplicationMenu().getMenuItemById('tabs')
}

async function runToggleChecks(win) {
  section('renderer: the View > Tabs toggle')

  // A dirty background document. Cancelling its prompt must change nothing:
  // tabs stay on, every document stays open, and the checkbox is reverted.
  const before = await win.webContents.executeJavaScript(`
    (async () => {
      const hook = window.__mdr
      await hook.selectTab(3) // fresh.md
      hook.typeIntoEditor('TOGGLE-DIRTY')
      await new Promise((r) => setTimeout(r, 250))
      await hook.selectTab(1) // USAGE.md stays active
      hook.setConfirmHandler(() => 'cancel')
      return hook.getTabs().map((t) => t.name)
    })()
  `)
  checkEqual('four tabs are open before the toggle', before, ['sample.md', 'USAGE.md', 'sibling.md', 'fresh.md'])

  const logStart = await win.webContents.executeJavaScript('window.__mdr.confirmLog().length')
  const okCancel = await sendTabsCommand(win, false)
  check('cancelling the prompt aborts turning tabs off', okCancel === false)
  const afterCancel = await tabsSnapshot(win)
  checkEqual('every tab is still open after the cancel', afterCancel.map((t) => t.name), before)
  check('the cancelled document kept its draft', afterCancel.find((t) => t.name === 'fresh.md').dirty === true)
  checkEqual('the View > Tabs checkbox was put back', menuTabsItem().checked, true)
  checkEqual('the settings file still says tabs on', readSettingsFile().tabs, true)
  const cancelPrompts = await win.webContents.executeJavaScript(`window.__mdr.confirmLog().slice(${logStart}).length`)
  checkEqual('exactly one prompt was shown before the cancel', cancelPrompts, 1)

  // Completing it: only the dirty document prompts, the rest are clean.
  await win.webContents.executeJavaScript('window.__mdr.setConfirmHandler(() => "discard")')
  const okOff = await sendTabsCommand(win, false)
  check('turning tabs off completed', okOff === true)
  checkEqual('tabs are now disabled', await win.webContents.executeJavaScript('window.__mdr.isTabsEnabled()'), false)
  const afterOff = await tabsSnapshot(win)
  checkEqual('the active document was kept, the others closed', afterOff.map((t) => t.name), ['USAGE.md'])
  checkEqual(
    'the tab strip is hidden',
    await win.webContents.executeJavaScript('document.getElementById("tab-strip").hidden'),
    true
  )
  checkEqual('the View > Tabs checkbox is unchecked', menuTabsItem().checked, false)
  checkEqual('the preference was persisted as off', readSettingsFile().tabs, false)
  checkEqual(
    'the close button switches to single-file wording',
    await win.webContents.executeJavaScript('document.getElementById("btn-close-file").textContent'),
    'Close File'
  )

  section('renderer: single-file mode replaces the document, with a prompt')
  const legacy = await win.webContents.executeJavaScript(`
    (async () => {
      const hook = window.__mdr
      const out = {}
      hook.typeIntoEditor('LEGACY-DIRTY')
      await new Promise((r) => setTimeout(r, 250))
      out.dirtyBefore = hook.getState().dirty
      hook.setConfirmHandler(() => 'cancel')
      out.cancelledOpen = await hook.openPath(${JSON.stringify(fixtureFile)})
      out.pathAfterCancel = hook.getState().docPath
      out.textAfterCancel = hook.getEditorText().includes('LEGACY-DIRTY')
      hook.setConfirmHandler(() => 'discard')
      out.discardedOpen = await hook.openPath(${JSON.stringify(fixtureFile)})
      out.pathAfterDiscard = hook.getState().docPath
      out.tabsAfterReplace = hook.getTabs().length
      out.textAfterDiscard = hook.getEditorText()
      return out
    })()
  `)
  check('the current document was dirty before the prompt', legacy.dirtyBefore === true)
  check('Cancel stops the replacement open', legacy.cancelledOpen === false)
  check('Cancel leaves the document untouched', legacy.pathAfterCancel === outsideFile && legacy.textAfterCancel === true)
  check('the replacement open proceeds after Discard', legacy.discardedOpen === true)
  checkEqual('the document was replaced, not tabbed', legacy.tabsAfterReplace, 1)
  check('the new file is on screen', legacy.pathAfterDiscard === fixtureFile)
  check('the discarded draft is gone', !/LEGACY-DIRTY/.test(legacy.textAfterDiscard || ''))

  section('renderer: turning tabs back on')
  const okOn = await sendTabsCommand(win, true)
  check('turning tabs back on completed', okOn === true)
  checkEqual('tabs are enabled again', await win.webContents.executeJavaScript('window.__mdr.isTabsEnabled()'), true)
  checkEqual(
    'the tab strip is visible again',
    await win.webContents.executeJavaScript('document.getElementById("tab-strip").hidden'),
    false
  )
  checkEqual('the View > Tabs checkbox is checked again', menuTabsItem().checked, true)
  checkEqual('the preference round-tripped to the settings file', readSettingsFile().tabs, true)
  const afterOn = await tabsSnapshot(win)
  checkEqual('the kept document is now its single tab', afterOn.map((t) => t.name), ['sample.md'])
}

/**
 * Rapid switching, concurrent opens, discarding background tabs, and files that
 * change on disk while open. The payload is run once per phase; between some
 * phases this driver writes to disk, because the renderer cannot.
 */
async function runRaceChecks(win) {
  section('renderer: rapid switching and concurrent opens')

  const source = fs.readFileSync(path.join(__dirname, 'smoke-race-payload.js'), 'utf8')
  const phase = async (name) => {
    progress(`race phase: ${name}`)
    await win.webContents.executeJavaScript(`window.__smokeRacePhase = ${JSON.stringify(name)}; true`)
    const result = await win.webContents.executeJavaScript(source, true)
    // Every phase answers its scripted prompts; anything else is a surprise the
    // run must report rather than hide.
    checkEqual(`no unexpected prompts during ${name}`, result.unexpectedPrompts || [], [])
    return result
  }

  const setup = await phase('setup')
  check('every close button is out of the tab order', setup.closeButtonsOutOfTabOrder === true)
  checkEqual('the child document opened next to the sample', setup.tabsAtSetup, ['sample.md', 'child.md'])
  check('rapid selections settle on the last one requested', setup.rapidActiveName === 'child.md', setup.rapidActiveName)
  check('a draft survives rapid switching in its own tab', setup.rapidChildDraftKept === true)
  check('rapid switching did not dirty the other tab', setup.rapidSampleDirty === false)
  check('the draft is still unsaved after rapid switching', setup.rapidChildDirty === true)
  check('the other tab shows its clean text after rapid switching', setup.sampleClean === true)
  check('the draft is still there when its tab is selected again', setup.childDraftStillThere === true)
  checkEqual('two concurrent opens of one file make one tab', setup.raceTabCount, 1)
  check('the concurrently opened file is the active tab', setup.raceActiveName === 'race.md', setup.raceActiveName)
  check('the concurrently opened file shows its disk text', setup.raceEditorMatchesDisk === true)
  check('reopening a file open in the background selects its tab', setup.reopenBackgroundName === 'child.md', setup.reopenBackgroundName)
  check('reopening a background tab keeps its draft', setup.reopenKeptDraft === true)

  section('renderer: discarding a background tab')

  const discard = await phase('discard')
  check('a cancelled prompt stops the quit-style check', discard.guardCancelled === true)
  checkEqual('the check prompted in tab order, skipping the clean tab', discard.promptedFor, ['child.md', 'race.md'])
  check('the discarded tab shows its saved text, not the draft', discard.discardedShowsSaved === true)
  check('the discarded tab is clean', discard.discardedDirty === false)
  check('Save on the discarded tab reports success', discard.saveOnDiscardedOk === true)
  check('the editor after Save still holds the saved text', discard.editorAfterSave === childText)
  check('the child file on disk holds the saved text after Save', fs.readFileSync(childFile, 'utf8') === childText)

  section('renderer: discarding the active document keeps it editable')
  check('the active document was editing before the discard', discard.raceEditableBefore === true)
  check('the discard check completed', discard.guardDiscardedRace === true)
  check('the active document stays editable after discard', discard.raceEditableAfterDiscard === true)
  checkEqual('the source pane is still contenteditable after discard', discard.raceContentEditableAfterDiscard, 'true')
  check('the active document shows its saved text after discard', discard.raceTextAfterDiscard === true)

  section('renderer: files changed on disk')

  await phase('disk-clean-1')
  fs.writeFileSync(raceFile, raceStates.two, 'utf8')
  const clean = await phase('disk-clean-2')
  check('a clean tab reloads when its file changed on disk', clean.cleanReloaded === true)
  check('a clean tab reloads without asking', clean.cleanPrompted === false)
  check('a reloaded clean tab is not dirty', clean.cleanDirty === false)

  await phase('disk-keep-1')
  fs.writeFileSync(raceFile, raceStates.three, 'utf8')
  const keep = await phase('disk-keep-2')
  checkEqual('an edited tab asks once when its file changed', keep.keepPrompts, 1)
  check('Keep my edits keeps the edits', keep.keepKeptEdits === true)
  check('the kept tab is still dirty', keep.keepStillDirty === true)
  check('re-selecting does not ask again for the same disk version', keep.keepAskedAgain === false)
  check('the kept edits survive re-selecting', keep.keptAfterReselect === true)

  await phase('disk-reload-1')
  fs.writeFileSync(raceFile, raceStates.four, 'utf8')
  const reload = await phase('disk-reload-2')
  checkEqual('a further change asks again', reload.reloadPrompts, 1)
  check('Reload from disk replaces the edits with the disk text', reload.reloadedText === true)
  check('a reloaded tab is clean', reload.reloadDirty === false)

  section('renderer: Tabs off is refused when a save fails')

  await phase('savefail-1')
  // Read-only on Windows makes the save fail, which is what the refused toggle must survive.
  fs.chmodSync(childFile, 0o444)
  let fail
  try {
    fail = await phase('savefail-2')
  } finally {
    fs.chmodSync(childFile, 0o666)
  }
  check('a failed save refuses the Tabs-off change', fail.toggleOk === false)
  check('tabs are still on after the refused change', fail.tabsStillOn === true)
  checkEqual('every tab is still open after the refused change', fail.tabsAfterFailedToggle, ['sample.md', 'child.md', 'race.md'])
  check('the unsaved child tab is still dirty', fail.childStillDirty === true)

  section('renderer: race checks clean up after themselves')
  const cleanup = await phase('cleanup')
  checkEqual('only the sample document remains', cleanup.tabsAfterCleanup, ['sample.md'])

  section('renderer: concurrent saves, switches and closes')
  const conc = await phase('concurrent')
  check('a save marks its own document clean', conc.saveOwnDocClean === true)
  check('a save never marks the switched-to document clean', conc.saveOtherStillDirty === true)
  check('edits made during a save stay unsaved', conc.editsDuringSaveStayUnsaved === true)
  check('Close Tab closes the document it asked about', conc.closeRightTabOk === true)
  checkEqual('the other tab stays open after Close Tab', conc.closeRightTabNames, ['sample.md'])
  check('the tab selected during the prompt stays active', conc.closeRightActiveKept === true)
  check('Tabs off completed', conc.toggleOrphanOk === true)
  checkEqual('Tabs off keeps only the document it started with', conc.toggleOrphanNames, ['sample.md'])
  check('the active tab is one of the open tabs after Tabs off', conc.toggleOrphanActiveIn === true)
  checkEqual('the kept document is shown again', conc.toggleOrphanActiveName, 'sample.md')
  check('Tabs back on completed', conc.toggleBackOn === true)
  checkEqual('closing a tab beats a navigation to it', conc.navCloseNames, ['sample.md'])
  check('no closed tab is left on screen', conc.navCloseActiveIn === true)
  checkEqual('the concurrent checks leave one document', conc.concurrentLeftNames, ['sample.md'])
  check('that document is clean for the checks below', conc.concurrentLeftClean === true)
}

async function runCloseChecks(win) {
  section('renderer: the close guard walks every open document')

  const source = fs.readFileSync(path.join(__dirname, 'smoke-close-payload.js'), 'utf8')
  progress('close-guard payload starting')
  const out = await win.webContents.executeJavaScript(source, true)
  rendererPayload = out
  progress('close-guard payload done')

  checkEqual('three tabs are open for the guard', out.tabsBeforeGuard, ['sample.md', 'fresh.md', 'sibling.md'])
  checkEqual('two of them are dirty', out.dirtyBeforeGuard, [false, true, true])
  check('Cancel on the second prompt stops the close', out.guardAfterCancel === false)
  checkEqual(
    'the guard prompted in tab order',
    out.promptsAfterCancel.map((message) => (/"([^"]+)"/.exec(message) || [])[1] || message),
    ['fresh.md', 'sibling.md']
  )
  checkEqual('the discarded document reverted, the cancelled one kept its draft', out.dirtyAfterCancelledGuard, [false, false, true])
  check('the close proceeds once every prompt resolves', out.guardAfterDiscard === true)
  checkEqual('both dirty documents were resolved', out.dirtyAfterDiscardGuard, [false, false, false])
  checkEqual('two documents are left dirty for the real close', out.dirtyAtEnd, [false, true, true])
}

async function runWindowCloseCheck(win) {
  section('window close is blocked until every unsaved document is resolved')

  // The real 'close' event, not the hook. With a Cancel answer the window must
  // survive its own close(), and the guard must actually have prompted.
  const logBefore = await win.webContents.executeJavaScript('window.__mdr.confirmLog().length')
  await win.webContents.executeJavaScript('window.__mdr.setConfirmHandler(() => "cancel")')
  progress('closing the real window (must be refused)')
  win.close()
  await waitFor(() => win.webContents.executeJavaScript(`window.__mdr.confirmLog().length > ${logBefore}`), {
    label: 'the close guard to prompt',
    timeout: 15000
  })
  check('a real window close is refused while documents are unsaved', !win.isDestroyed() && BrowserWindow.getAllWindows().length === 1)

  // Let it through: every prompt answers Discard and the window closes.
  await win.webContents.executeJavaScript('window.__mdr.setConfirmHandler(() => "discard")')
  const closed = new Promise((resolve) => win.once('closed', resolve))
  progress('closing the real window (must now close)')
  win.close()
  const didClose = await Promise.race([
    closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 20000))
  ])
  check('the window closed once the prompts were resolved', didClose === true)
  checkEqual('no windows remain', BrowserWindow.getAllWindows().length, 0)
}

/* --------------------------------------------------------------- the driver */

async function main() {
  // The smoke run owns the process lifecycle: the final check closes the real
  // window on purpose and app.exit() happens in the report path. Electron's
  // default window-all-closed -> app.quit() would race the report.
  app.removeAllListeners('window-all-closed')

  checkBuildArtifacts()
  checkFsApi()
  checkSettingsDefaults()
  progress('pre-boot checks done')

  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], {
    label: 'the application window',
    timeout: 30000
  })

  win.hide()
  // Belt and braces with the command-line switches above: no throttling for the
  // renderer that is about to be hidden.
  win.webContents.setBackgroundThrottling(false)

  // Renderer console lines that start with "[smoke]" are progress markers from
  // the injected payloads; forward them so a hang shows its last phase.
  win.webContents.on('console-message', (...args) => {
    const first = args[0]
    const message =
      first && typeof first === 'object' && 'message' in first
        ? first.message
        : args[2]
    if (typeof message === 'string' && message.startsWith('[smoke]')) {
      console.error(`[renderer] ${message}`)
    }
  })

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
      childFile,
      childText,
      freshFile,
      freshText,
      siblingFile,
      siblingText,
      outsideFile,
      outsideDir,
      raceFile,
      raceStates,
      outsideText: fs.readFileSync(outsideFile, 'utf8'),
      binaryFile,
      hostileMarkdown
    })}; true`
  )

  const payloadSource = fs.readFileSync(path.join(__dirname, 'smoke-payload.js'), 'utf8')
  progress('main payload starting')
  rendererPayload = await win.webContents.executeJavaScript(payloadSource, true)
  progress('main payload done')

  runPayloadChecks(rendererPayload)
  checkMenuEnabledState()

  await runToggleChecks(win)
  await runRaceChecks(win)
  progress('tabs toggle phase done')
  await runCloseChecks(win)
  progress('close-guard phase done')
  await runWindowCloseCheck(win)
  progress('window-close phase done')
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
