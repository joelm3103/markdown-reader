// Renderer entry point: document tabs, mode switching, the folder tree,
// unsaved-changes handling, drag-and-drop, and scroll sync between the source
// and preview panes.
//
// Documents live in `state.tabs`. With tabs enabled (the default) every open
// document keeps its own record — text, dirty flag, editability, CodeMirror
// state (undo history and selection) and reading position — and only the active
// one is mirrored into `state` and shown in the panes. With tabs disabled the
// same machinery holds exactly one document, which is the old single-file
// behaviour: opening another file replaces it and prompts about unsaved work.

import 'highlight.js/styles/github-dark-dimmed.css'
import './styles.css'

import { createEditor } from './editor.js'
import { renderMarkdown } from './markdown.js'
import { lineToOffset, offsetToLine, proportionalOffset, isMonotonic } from './linemap.js'
import { dirname, resolveRelative, isMarkdownPath, isExternalUrl, isPathInside, isSamePath } from './paths.js'

const api = window.mdapi

const el = (id) => document.getElementById(id)

const dom = {
  body: document.body,
  sidebar: el('sidebar'),
  tree: el('tree'),
  folderName: el('folder-name'),
  tabStrip: el('tab-strip'),
  fileName: el('file-name'),
  dirtyDot: el('dirty-dot'),
  save: el('btn-save'),
  closeFile: el('btn-close-file'),
  editing: el('btn-editing'),
  editingLabel: el('editing-label'),
  editorHost: el('editor-host'),
  previewHost: el('preview-host'),
  sourcePane: document.querySelector('.pane-source'),
  splitter: el('splitter'),
  toast: el('toast')
}

const FLUSH_MS = 120
const MODES = ['split', 'source', 'preview']

// The fields that make up a document record. The active document's record is
// mirrored into `state` (so the rest of this file can keep working on `state`);
// everything outside this list is session-wide (mode, tabs, tabsEnabled) or a
// measurement cache (offsets).
const DOC_FIELDS = [
  'docPath',
  'text',
  'savedText',
  'dirty',
  'editable',
  'lineMap',
  'monotonic',
  'documentLines',
  'previewStale',
  'resetScrollOnNextRender',
  'hasFile'
]

let tabSeq = 0

const state = {
  // --- the active document (see DOC_FIELDS) ---------------------------------
  docPath: null,
  text: '',
  savedText: '',
  dirty: false,
  // Documents open read-only. Only an explicit toggle allows editing, so a stray
  // keystroke cannot silently modify a file the user is only reading.
  editable: false,
  lineMap: [],
  monotonic: true,
  documentLines: 1,
  previewStale: true,
  resetScrollOnNextRender: true,
  hasFile: false,

  // --- session-wide ---------------------------------------------------------
  mode: 'split',
  tabsEnabled: true,
  tabs: [],
  activeId: null,

  // Measurement cache for the rendered preview. Only valid for the active
  // document, and never carried across a tab switch.
  offsets: null
}

let editor = null

let flushTimer = 0
let toastTimer = 0

// Scroll-sync bookkeeping: whoever initiated a sync owns the lock until the
// other pane has finished reacting, which is what stops the two panes from
// driving each other in a loop.
let syncOwner = null
let syncOwnerTimer = 0
let syncFrame = 0
// Restoring a tab's reading position moves both panes programmatically; those
// moves must not be mistaken for user scrolling and synced back against each
// other, or one pane would yank the other away from its saved position.
let syncSuspendedUntil = 0

// Test hook: the smoke test replaces the native Save/Discard/Cancel dialog with
// scripted answers so the destructive branches can be driven automatically.
let confirmHandler = null
const confirmLog = []

/* ------------------------------------------------------------------ helpers */

function baseName(filePath) {
  if (!filePath) return null
  const parts = String(filePath).split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

function showToast(message, kind = 'info') {
  if (!dom.toast) return
  dom.toast.textContent = message
  dom.toast.className = kind === 'error' ? 'toast error' : 'toast'
  dom.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    dom.toast.hidden = true
  }, kind === 'error' ? 6000 : 2600)
}

function docDir() {
  return state.docPath ? dirname(state.docPath) : null
}

function activeTab() {
  return state.tabs.find((tab) => tab.id === state.activeId) || null
}

function findTabByPath(filePath) {
  return state.tabs.find((tab) => isSamePath(tab.docPath, filePath)) || null
}

function makeTab(filePath, text) {
  return {
    id: ++tabSeq,
    docPath: filePath,
    text,
    savedText: text,
    dirty: false,
    editable: false,
    lineMap: [],
    monotonic: true,
    documentLines: 1,
    previewStale: true,
    resetScrollOnNextRender: true,
    hasFile: Boolean(filePath),
    // Captured when the tab is left behind; see stashActive().
    cmState: null,
    editorScroll: 0,
    previewScroll: 0
  }
}

/* ------------------------------------------------------------- read-only UI */

function refreshEditingState() {
  const editable = Boolean(state.editable) && state.hasFile
  dom.editing.disabled = !state.hasFile
  dom.editing.classList.toggle('is-editing', editable)
  dom.editing.classList.toggle('is-readonly', !editable)
  dom.editing.setAttribute('aria-pressed', String(editable))
  dom.editing.title = state.hasFile
    ? editable
      ? 'Editing enabled. Click, or press Ctrl+E, to go back to read-only.'
      : 'Read-only. Click, or press Ctrl+E, to start editing.'
    : 'Open a file to edit it'
  dom.editingLabel.textContent = editable ? 'Editing' : 'Read-only'
  dom.editing.querySelector('.editing-glyph').textContent = editable ? '✎' : '🔒'
}

function setEditable(value, { focus = false } = {}) {
  state.editable = Boolean(value)
  if (editor) {
    editor.setEditable(state.editable)
    if (state.editable && focus) editor.focus()
  }
  refreshEditingState()
}

function toggleEditing() {
  if (!state.hasFile) {
    showToast('Open a file before editing.')
    return
  }
  const next = !state.editable
  setEditable(next, { focus: next })
  showToast(next ? 'Editing enabled — Ctrl+S saves' : 'Read-only again')
}

/* -------------------------------------------------------------- dirty state */

function tabIsDirty(tab) {
  if (!tab) return false
  return tab.id === state.activeId ? state.dirty : tab.text !== tab.savedText
}

function anyDirty() {
  return state.tabs.some((tab) => tabIsDirty(tab))
}

/** Updates the per-tab dirty markers without rebuilding the strip. */
function refreshTabDirty() {
  if (dom.tabStrip.hidden) return
  for (const node of dom.tabStrip.querySelectorAll('.tab')) {
    const tab = state.tabs.find((candidate) => String(candidate.id) === node.dataset.id)
    const dot = node.querySelector('.tab-dirty')
    if (tab && dot) dot.hidden = !tabIsDirty(tab)
  }
}

function refreshDocState() {
  const dirty = state.text !== state.savedText
  if (dirty !== state.dirty) state.dirty = dirty

  dom.dirtyDot.hidden = !state.dirty
  dom.save.disabled = !state.dirty || !state.hasFile
  dom.closeFile.disabled = !state.hasFile
  dom.closeFile.textContent = state.tabsEnabled ? 'Close Tab' : 'Close File'
  dom.closeFile.title = state.tabsEnabled ? 'Close tab (Ctrl+W)' : 'Close file (Ctrl+W)'
  refreshEditingState()
  dom.body.classList.toggle('no-file', !state.hasFile)
  dom.body.classList.toggle('has-file', state.hasFile)

  const name = baseName(state.docPath)
  dom.fileName.textContent = name || 'No file open'
  dom.fileName.title = state.docPath || 'No file open'

  const title = name
    ? `${state.dirty ? '• ' : ''}${name} — markdown-reader`
    : 'markdown-reader'

  api.setDocState({
    dirty: state.dirty,
    // Every open document, not just the active one: an unsaved edit in a
    // background tab must still stop the window from closing.
    anyDirty: anyDirty(),
    hasFile: state.hasFile,
    title,
    closeLabel: state.tabsEnabled ? 'Close Tab' : 'Close File'
  })

  refreshTabDirty()
}

/* ------------------------------------------------------------- tab records */

/**
 * Copies the active document back into its tab record.
 *
 * Called before anything that looks at a tab other than the one on screen
 * (switching, closing others, the quit guard), so the record — not a possibly
 * stale mirror — is what those paths see.
 */
function stashActive() {
  const tab = activeTab()
  if (!tab) return

  state.text = currentTextFromVisiblePane()
  state.dirty = state.text !== state.savedText

  for (const field of DOC_FIELDS) tab[field] = state[field]

  if (editor) {
    tab.cmState = editor.getState()
    tab.editorScroll = editor.scrollTop()
  }
  tab.previewScroll = dom.previewHost.scrollTop
}

/** Makes `tab` the active document: swap state, editor and preview in one go. */
async function applyTab(tab) {
  state.activeId = tab.id
  for (const field of DOC_FIELDS) state[field] = tab[field]
  state.offsets = null

  suspendSync()
  cancelPendingPreview()

  // Image scope is per document, so it must be set before the preview renders
  // and requests its images.
  await api.setCurrentDoc(tab.docPath)

  if (editor) {
    if (tab.cmState) editor.setState(tab.cmState)
    else editor.resetTo(tab.text)
    editor.setScrollTop(tab.editorScroll || 0)
    // The swapped-in CodeMirror state carries its own editability, but keep the
    // pane and the toolbar explicitly in agreement with the record.
    editor.setEditable(Boolean(tab.editable))
  }

  renderPreview({ scrollTop: tab.previewScroll || 0 })
  refreshDocState()
  markTreeActive()
  renderTabs()
}

/**
 * Opens a brand-new active tab for `filePath`.
 *
 * With tabs on the current document keeps its own tab; with tabs off it is
 * replaced (single-file mode), which is why the record list is rebuilt there.
 */
async function activateNewTab(filePath, text, { resetScroll = true } = {}) {
  if (activeTab()) stashActive()

  const tab = makeTab(filePath, text)
  tab.resetScrollOnNextRender = resetScroll !== false
  // Every document starts read-only, whatever the previous one was.
  tab.editable = false

  state.tabs = state.tabsEnabled ? [...state.tabs, tab] : [tab]
  await applyTab(tab)
}

/** Closes every tab and returns to the start screen. */
async function clearActiveDocument() {
  state.activeId = null
  state.docPath = null
  state.text = ''
  state.savedText = ''
  state.hasFile = false
  state.dirty = false
  state.editable = false
  state.lineMap = []
  state.offsets = null
  state.monotonic = true
  state.documentLines = 1
  state.previewStale = true
  state.resetScrollOnNextRender = true

  suspendSync()
  cancelPendingPreview()

  if (editor) {
    editor.resetTo('')
    editor.setScrollTop(0)
  }
  setEditable(false)

  // Drops the asset scope, so nothing from the closed document stays reachable.
  await api.setCurrentDoc(null)

  refreshDocState()
  markTreeActive()
  renderTabs()
  renderPreview()
}

async function activateTabById(id) {
  const tab = state.tabs.find((candidate) => candidate.id === id)
  if (!tab || tab.id === state.activeId) return false
  stashActive()
  await applyTab(tab)
  return true
}

/**
 * Closes one tab by id, prompting first when that document has unsaved changes.
 * Closing the active tab selects a neighbour; closing a background tab leaves
 * the active one alone.
 */
async function closeTabById(id) {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return false

  if (id === state.activeId) return closeFile()

  if (!(await resolveUnsaved(state.tabs[index]))) return false
  state.tabs.splice(index, 1)
  renderTabs()
  refreshDocState()
  return true
}

/* ------------------------------------------------------------ mode handling */

function currentTextFromVisiblePane() {
  // The source editor is the only editable pane, so it is the source of truth
  // whenever it is on screen. Preview never writes, and Split shows both.
  if (editor && (state.mode === 'source' || state.mode === 'split')) return editor.getText()
  return state.text
}

function cancelPendingPreview() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = 0
  }
}

function flushPreview() {
  cancelPendingPreview()
  state.text = currentTextFromVisiblePane()
  renderPreview()
}

function schedulePreview() {
  if (state.mode !== 'split' && state.mode !== 'preview') return
  cancelPendingPreview()
  flushTimer = setTimeout(() => {
    flushTimer = 0
    renderPreview()
  }, FLUSH_MS)
}

function syncEditorsForMode(mode) {
  // Both panes render from the same markdown, so switching modes only needs the
  // newly visible pane to catch up — which setMode does via flushPreview() and
  // renderPreview(). CodeMirror additionally needs a measure when it becomes
  // visible, because it cannot size itself while hidden.
  if (!editor) return
  if (mode === 'source' || mode === 'split') {
    editor.refresh()
  }
}

async function setMode(mode, options = {}) {
  if (!MODES.includes(mode)) return
  if (state.mode === mode) {
    if (options.persist !== false) api.saveSettings({ mode })
    return
  }

  // Any pending debounced edit has to land before the panes are switched, or the
  // newly visible pane renders stale content.
  if (flushTimer) flushPreview()

  state.mode = mode
  dom.body.dataset.mode = mode
  updateModeButtons()

  syncEditorsForMode(mode)

  if (mode === 'split' || mode === 'preview') {
    if (state.previewStale) renderPreview()
  }

  if (mode === 'source' || mode === 'split') {
    // CodeMirror measures while hidden, so it needs to be told the box changed.
    requestAnimationFrame(() => editor && editor.refresh())
  }

  state.offsets = null
  if (options.persist !== false) api.saveSettings({ mode })
}

function updateModeButtons() {
  for (const button of document.querySelectorAll('.mode-button')) {
    const active = button.dataset.mode === state.mode
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  }
}

/* --------------------------------------------------------- preview renderer */

function previewPaddingTop() {
  const style = window.getComputedStyle(dom.previewHost)
  const value = parseFloat(style.paddingTop)
  return Number.isFinite(value) ? value : 0
}

function measureOffsets() {
  if (state.offsets) return state.offsets
  const pad = previewPaddingTop()
  const blocks = dom.previewHost.querySelectorAll('.md-block')
  state.offsets = Array.from(blocks, (node) => node.offsetTop - pad)
  return state.offsets
}

function previewMaxScroll() {
  return Math.max(0, dom.previewHost.scrollHeight - dom.previewHost.clientHeight)
}

/** Source line -> preview scrollTop, anchored on measured block offsets. */
function previewOffsetForLine(line) {
  if (state.monotonic && state.lineMap.length > 0) {
    const offsets = measureOffsets()
    if (offsets.length === state.lineMap.length) {
      return Math.min(lineToOffset(state.lineMap, offsets, line), previewMaxScroll())
    }
  }
  const span = Math.max(1, state.documentLines - 1)
  return proportionalOffset(Math.max(0, line - 1), span, previewMaxScroll())
}

/** Preview scrollTop -> source line. */
function lineForPreviewOffset(offset) {
  if (state.monotonic && state.lineMap.length > 0) {
    const offsets = measureOffsets()
    if (offsets.length === state.lineMap.length) {
      return offsetToLine(state.lineMap, offsets, offset)
    }
  }
  const max = previewMaxScroll()
  const ratio = max > 0 ? offset / max : 0
  return Math.round(1 + Math.max(0, Math.min(1, ratio)) * Math.max(0, state.documentLines - 1))
}

/**
 * Renders `state.text` into the preview.
 *
 * `scrollTop` pins the result to an exact position (used to restore a tab's
 * reading position); otherwise the pane is anchored to where the reader was in
 * source-line terms, so a re-render does not yank the preview back to the top
 * while they are typing.
 */
function renderPreview({ scrollTop = null } = {}) {
  let anchoredLine = 1
  const anchorToLine = scrollTop === null && !state.resetScrollOnNextRender && state.lineMap.length > 0
  if (anchorToLine) {
    anchoredLine = lineForPreviewOffset(dom.previewHost.scrollTop)
  }

  const result = renderMarkdown(state.text, { docDir: docDir() })

  dom.previewHost.innerHTML = result.html
  state.lineMap = result.lineMap
  state.monotonic = isMonotonic(result.lineMap) && result.monotonic
  state.documentLines = result.documentLines
  state.offsets = null
  state.previewStale = false

  if (scrollTop !== null) {
    dom.previewHost.scrollTop = scrollTop
    state.resetScrollOnNextRender = false
  } else if (state.resetScrollOnNextRender) {
    dom.previewHost.scrollTop = 0
    state.resetScrollOnNextRender = false
  } else {
    dom.previewHost.scrollTop = previewOffsetForLine(anchoredLine)
  }
}

/* -------------------------------------------------------------- scroll sync */

function suspendSync(ms = 180) {
  syncSuspendedUntil = Date.now() + ms
  syncOwner = null
  clearTimeout(syncOwnerTimer)
  cancelAnimationFrame(syncFrame)
}

function syncSuspended() {
  return Date.now() < syncSuspendedUntil
}

function ownSync(owner) {
  syncOwner = owner
  clearTimeout(syncOwnerTimer)
  syncOwnerTimer = setTimeout(() => {
    syncOwner = null
  }, 90)
}

function onEditorScroll() {
  if (state.mode !== 'split' || syncSuspended() || syncOwner === 'preview') return
  cancelAnimationFrame(syncFrame)
  syncFrame = requestAnimationFrame(() => {
    ownSync('editor')
    dom.previewHost.scrollTop = previewOffsetForLine(editor.lineAtTop())
  })
}

function onPreviewScroll() {
  if (state.mode !== 'split' || syncSuspended() || syncOwner === 'editor') return
  cancelAnimationFrame(syncFrame)
  syncFrame = requestAnimationFrame(() => {
    ownSync('preview')
    editor.scrollToLine(lineForPreviewOffset(dom.previewHost.scrollTop))
  })
}

/* ------------------------------------------------------------- unsaved work */

/**
 * Resolves one document's unsaved changes through Save / Discard / Cancel.
 * Returns false when the user cancels (or a save fails), and the caller must
 * then leave that document open and untouched.
 */
async function resolveUnsaved(tab) {
  if (!tab || tab.text === tab.savedText) return true

  const choice = await askUnsaved(`"${baseName(tab.docPath) || 'Untitled'}" has unsaved changes.`)
  if (choice === 'cancel') return false
  if (choice === 'discard') {
    // The changes are gone: put the document back to what is on disk. Most
    // callers close or replace it immediately afterwards, but when a later
    // prompt is cancelled this document survives and must not still be showing
    // edits the user was told had been discarded.
    tab.text = tab.savedText
    tab.dirty = false
    if (tab.id === state.activeId) {
      state.text = tab.text
      state.savedText = tab.savedText
      state.dirty = false
      if (editor) editor.resetTo(tab.text)
      refreshDocState()
    } else {
      refreshTabDirty()
    }
    return true
  }

  const result = await api.save(tab.docPath, tab.text)
  if (!result.ok) {
    showToast(result.error, 'error')
    return false
  }

  tab.savedText = tab.text
  if (tab.id === state.activeId) {
    state.savedText = state.text
    refreshDocState()
  } else {
    refreshTabDirty()
  }
  showToast(`Saved ${baseName(tab.docPath)}`)
  return true
}

function askUnsaved(message) {
  confirmLog.push(message)
  if (confirmHandler) return Promise.resolve(confirmHandler(message, confirmLog.length))
  return api.confirmDiscard(message)
}

/**
 * Asks about unsaved work on the active document. Returns false when the user
 * cancels.
 *
 * The visible pane is flushed into the tab record first, so the prompt is based
 * on what is actually on screen rather than on a possibly stale `dirty` flag.
 */
async function confirmDiscard() {
  stashActive()
  return resolveUnsaved(activeTab())
}

/**
 * Resolves every open document's unsaved changes, for window close / quit.
 * Background tabs are checked too: a document in another tab is just as lost if
 * the window closes on top of it.
 */
async function confirmAllDirty() {
  stashActive()
  for (const tab of state.tabs) {
    if (!(await resolveUnsaved(tab))) return false
  }
  const tab = activeTab()
  if (tab) {
    state.savedText = tab.savedText
    refreshDocState()
  }
  return true
}

/**
 * Before replacing the current document in single-file mode.
 *
 * With tabs on, opening never discards anything — the current document keeps
 * its own tab — so there is nothing to confirm.
 */
async function guardSwitch() {
  if (state.tabsEnabled) return true
  return confirmDiscard()
}

/* ----------------------------------------------------------------- file I/O */

async function loadFile(filePath, { resetScroll = true } = {}) {
  // Register before reading. A dropped or linked file outside the opened folder is
  // not in the allowed path scope yet, so reading it first would be refused and
  // the failure would look like a bad file rather than a scope decision.
  const registering = await api.registerDropped(filePath)
  if (!registering.ok) {
    showToast(registering.error, 'error')
    return false
  }

  // Already open? Select its tab instead of reading the file again: a reread
  // would throw away unsaved edits, and the bytes on disk are not necessarily
  // what the user is looking at. Single-file mode has no such shortcut — there
  // reopening really does reload.
  const existing = state.tabsEnabled ? findTabByPath(filePath) : null
  if (existing) {
    if (existing.id !== state.activeId) await activateTabById(existing.id)
    return true
  }

  const result = await api.read(filePath)
  if (!result.ok) {
    showToast(result.error, 'error')
    return false
  }

  await api.setCurrentDoc(filePath)
  await activateNewTab(filePath, result.content, { resetScroll })

  return true
}

/**
 * Closes the current document without quitting: the app and the folder tree stay
 * open, so another file can be picked straight away. With tabs enabled this
 * closes the active tab and selects a neighbour instead.
 */
async function closeFile() {
  if (!state.hasFile) return false
  if (!(await confirmDiscard())) return false

  const index = state.tabs.findIndex((tab) => tab.id === state.activeId)
  if (index >= 0) state.tabs.splice(index, 1)

  if (state.tabs.length === 0) {
    await clearActiveDocument()
    return true
  }

  // The tab to the right if there is one, otherwise the new last tab.
  const next = state.tabs[Math.min(Math.max(index, 0), state.tabs.length - 1)]
  await applyTab(next)
  return true
}

async function saveFile() {
  if (!state.docPath) {
    showToast('Nothing to save yet — open a file first.', 'error')
    return false
  }

  state.text = currentTextFromVisiblePane()
  const result = await api.save(state.docPath, state.text)
  if (!result.ok) {
    showToast(result.error, 'error')
    return false
  }

  state.savedText = state.text
  refreshDocState()
  showToast(`Saved ${baseName(state.docPath)}`)
  return true
}

async function openFileFlow() {
  if (!(await guardSwitch())) return
  const chosen = await api.openFileDialog()
  if (!chosen || chosen.canceled) return
  await loadFile(chosen.path)
}

async function openFolderFlow() {
  if (!(await guardSwitch())) return
  const chosen = await api.openFolderDialog()
  if (!chosen || chosen.canceled) return
  await setRoot(chosen.path)
}

/* ------------------------------------------------------------ tabs on/off */

// Completion signal for the smoke test: it drives the View > Tabs command from
// the main process and needs to know when the transition (which is asynchronous
// and can end in a cancel) has actually finished.
let lastToggleState = { desired: null, done: true, ok: null }

async function setTabsEnabledFlow(desired) {
  const enable = Boolean(desired)
  lastToggleState = { desired: enable, done: false, ok: null }
  const ok = await runTabsToggle(enable)
  lastToggleState = { desired: enable, done: true, ok }
  return ok
}

/**
 * The View > Tabs toggle.
 *
 * Turning tabs off keeps the active document and closes the others, resolving
 * each one's unsaved changes first. Any Cancel — or a save that fails — aborts
 * the whole change and leaves tabs on, because half a transition would silently
 * drop documents the user was promised a prompt for.
 */
async function runTabsToggle(enable) {
  if (enable === state.tabsEnabled) {
    await api.setTabs(enable) // keeps the menu checkbox honest
    return true
  }

  if (!enable) {
    stashActive()
    const keepId = state.activeId
    const closing = state.tabs.filter((tab) => tab.id !== keepId)

    for (const tab of closing) {
      if (!(await resolveUnsaved(tab))) {
        await api.setTabs(true)
        showToast('Tabs stay on — closing the other documents was cancelled.', 'error')
        return false
      }
    }

    state.tabs = state.tabs.filter((tab) => tab.id === keepId)
    if (closing.length > 0) showToast('Tabs off — the other documents were closed.')
  }

  state.tabsEnabled = enable
  await api.setTabs(enable)
  renderTabs()
  refreshDocState()
  return true
}

/* -------------------------------------------------------------- tab strip */

function renderTabs() {
  const show = state.tabsEnabled && state.tabs.length > 0
  dom.body.classList.toggle('tabs-enabled', state.tabsEnabled)
  dom.tabStrip.hidden = !show
  dom.tabStrip.textContent = ''
  if (!show) return

  for (const tab of state.tabs) {
    dom.tabStrip.append(buildTabNode(tab))
  }
}

function buildTabNode(tab) {
  const isActive = tab.id === state.activeId
  const name = baseName(tab.docPath) || 'Untitled'

  const node = document.createElement('div')
  node.className = isActive ? 'tab active' : 'tab'
  node.dataset.id = String(tab.id)
  node.setAttribute('role', 'tab')
  node.setAttribute('aria-selected', String(isActive))
  // Roving tabindex: one stop for the whole strip, arrows move between tabs.
  node.tabIndex = isActive ? 0 : -1
  node.title = tab.docPath || ''

  const label = document.createElement('span')
  label.className = 'tab-label'
  label.textContent = name

  const dirty = document.createElement('span')
  dirty.className = 'tab-dirty'
  dirty.title = 'Unsaved changes'
  dirty.hidden = !tabIsDirty(tab)

  const close = document.createElement('button')
  close.className = 'tab-close'
  close.type = 'button'
  close.title = `Close ${name}`
  close.setAttribute('aria-label', `Close ${name}`)
  close.textContent = '\u00d7'
  close.addEventListener('click', (event) => {
    event.stopPropagation()
    void closeTabById(tab.id)
  })

  node.append(label, dirty, close)
  node.addEventListener('click', () => void activateTabById(tab.id))
  node.addEventListener('keydown', onTabKeyDown)
  return node
}

function onTabKeyDown(event) {
  const index = state.tabs.findIndex((tab) => String(tab.id) === event.currentTarget.dataset.id)
  if (index < 0) return

  const last = state.tabs.length - 1
  let target = null
  switch (event.key) {
    case 'ArrowLeft':
      target = state.tabs[index > 0 ? index - 1 : last]
      break
    case 'ArrowRight':
      target = state.tabs[index < last ? index + 1 : 0]
      break
    case 'Home':
      target = state.tabs[0]
      break
    case 'End':
      target = state.tabs[last]
      break
    case 'Delete':
      event.preventDefault()
      void closeTabById(state.tabs[index].id)
      return
    default:
      return
  }

  event.preventDefault()
  void activateTabById(target.id).then(() => {
    const node = dom.tabStrip.querySelector(`.tab[data-id="${target.id}"]`)
    if (node) node.focus()
  })
}

/* ---------------------------------------------------------------- the tree */

const treeState = {
  root: null,
  // dirPath -> { entries, error }
  listing: new Map(),
  expanded: new Set()
}

async function loadListing(dirPath) {
  const result = await api.list(dirPath)
  treeState.listing.set(dirPath, {
    entries: result.ok ? result.entries : [],
    error: result.ok ? null : result.error
  })
}

async function setRoot(dirPath) {
  treeState.root = dirPath
  treeState.listing.clear()
  treeState.expanded.clear()
  // The folder the user just opened starts expanded, otherwise "Open Folder"
  // appears to do nothing. Its children are only listed one level deep.
  treeState.expanded.add(dirPath)
  await loadListing(dirPath)
  dom.folderName.textContent = baseName(dirPath) || dirPath
  dom.folderName.title = dirPath
  renderTree()
}

function buildDirNode(dirPath, depth) {
  const fragment = document.createDocumentFragment()
  const listing = treeState.listing.get(dirPath)
  const isOpen = treeState.expanded.has(dirPath)

  const row = document.createElement('div')
  row.className = 'tree-row dir'
  row.style.paddingLeft = `${8 + depth * 12}px`
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-expanded', String(isOpen))

  const caret = document.createElement('span')
  caret.className = 'caret'
  caret.textContent = isOpen ? '▾' : '▸'

  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = baseName(dirPath) || dirPath

  row.append(caret, label)
  row.addEventListener('click', () => toggleDir(dirPath))
  fragment.append(row)

  if (!isOpen) return fragment

  if (!listing) {
    // Not listed yet: fetch this one level, then redraw.
    loadListing(dirPath).then(renderTree)
    return fragment
  }

  if (listing.error) {
    const error = document.createElement('div')
    error.className = 'tree-empty tree-error'
    error.style.paddingLeft = `${24 + depth * 12}px`
    error.textContent = listing.error
    fragment.append(error)
    return fragment
  }

  if (listing.entries.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'tree-empty'
    empty.style.paddingLeft = `${24 + depth * 12}px`
    empty.textContent = 'No markdown files'
    fragment.append(empty)
    return fragment
  }

  for (const entry of listing.entries) {
    if (entry.type === 'dir') {
      fragment.append(buildDirNode(entry.path, depth + 1))
    } else {
      fragment.append(buildFileRow(entry, depth + 1))
    }
  }

  return fragment
}

function buildFileRow(entry, depth) {
  const row = document.createElement('div')
  row.className = 'tree-row file'
  row.dataset.path = entry.path
  row.style.paddingLeft = `${20 + depth * 12}px`
  row.setAttribute('role', 'treeitem')
  if (state.docPath === entry.path) row.classList.add('active')

  const spacer = document.createElement('span')
  spacer.className = 'caret'
  spacer.textContent = ''

  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = entry.name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '')

  row.append(spacer, label)
  row.addEventListener('click', async () => {
    if (state.docPath === entry.path) return
    if (!(await guardSwitch())) return
    await loadFile(entry.path)
  })

  return row
}

function renderTree() {
  dom.tree.textContent = ''

  if (!treeState.root) {
    const hint = document.createElement('div')
    hint.className = 'tree-empty'
    hint.textContent = 'Open a folder to browse its markdown files.'
    dom.tree.append(hint)
    return
  }

  dom.tree.append(buildDirNode(treeState.root, 0))
}

/** Empties the tree, e.g. when the open document no longer belongs to it. */
function clearTree() {
  treeState.root = null
  treeState.listing.clear()
  treeState.expanded.clear()
  dom.folderName.textContent = 'No folder'
  dom.folderName.title = 'No folder opened'
  renderTree()
}

/**
 * Keeps the tree honest about the document on screen.
 *
 * A file opened from somewhere else leaves the tree showing an unrelated folder,
 * which is worse than showing nothing — so the tree is cleared unless it can
 * actually account for the file. Note this deliberately does not adopt the
 * dropped file's own folder as the new root: dropping one file should not
 * silently re-point the whole sidebar.
 */
function reconcileTreeWithDocument(filePath) {
  if (!treeState.root) return
  if (isPathInside(filePath, treeState.root)) {
    markTreeActive()
    return
  }
  clearTree()
}

function markTreeActive() {
  for (const row of dom.tree.querySelectorAll('.tree-row.file')) {
    row.classList.toggle('active', row.dataset.path === state.docPath)
  }
}

async function toggleDir(dirPath) {
  if (treeState.expanded.has(dirPath)) {
    treeState.expanded.delete(dirPath)
  } else {
    treeState.expanded.add(dirPath)
  }
  renderTree()
}

async function refreshTree() {
  if (!treeState.root) return
  const root = treeState.root
  const expanded = Array.from(treeState.expanded)

  await setRoot(root)
  for (const dir of expanded) {
    treeState.expanded.add(dir)
    if (!treeState.listing.has(dir)) await loadListing(dir)
  }
  renderTree()
  markTreeActive()
  showToast('Folder refreshed')
}

/* ------------------------------------------------------------ interactions */

function wireUi() {
  el('btn-open-file').addEventListener('click', openFileFlow)
  el('btn-open-folder').addEventListener('click', openFolderFlow)
  el('btn-empty-open-file').addEventListener('click', openFileFlow)
  el('btn-empty-open-folder').addEventListener('click', openFolderFlow)
  el('btn-refresh').addEventListener('click', refreshTree)
  dom.save.addEventListener('click', saveFile)
  dom.closeFile.addEventListener('click', closeFile)
  dom.editing.addEventListener('click', toggleEditing)

  el('btn-sidebar').addEventListener('click', () => {
    dom.body.classList.toggle('sidebar-hidden')
    if (editor) editor.refresh()
  })

  for (const button of document.querySelectorAll('.mode-button')) {
    button.addEventListener('click', () => setMode(button.dataset.mode))
  }

  wireSplitter()
  wireDragAndDrop()
  wirePreviewLinks()

  dom.previewHost.addEventListener('scroll', onPreviewScroll, { passive: true })

  window.addEventListener('resize', () => {
    state.offsets = null
    if (editor) editor.refresh()
  })

  api.onCommand(async (command, payload) => {
    switch (command) {
      case 'open-file':
        await openFileFlow()
        break
      case 'open-folder':
        await openFolderFlow()
        break
      case 'save':
        await saveFile()
        break
      case 'close-file':
        await closeFile()
        break
      case 'toggle-editing':
        toggleEditing()
        break
      case 'toggle-tabs':
        await setTabsEnabledFlow(payload)
        break
      case 'undo':
        if (editor) editor.undo()
        break
      case 'redo':
        if (editor) editor.redo()
        break
      case 'mode':
        await setMode(payload)
        break
      case 'toggle-sidebar':
        dom.body.classList.toggle('sidebar-hidden')
        if (editor) editor.refresh()
        break
      case 'request-close':
        if (await confirmAllDirty()) await api.closeConfirmed()
        break
      default:
        break
    }
  })
}

function wireSplitter() {
  let dragging = false

  const onMove = (event) => {
    if (!dragging) return
    const panes = dom.sourcePane.parentElement
    const rect = panes.getBoundingClientRect()
    const percent = ((event.clientX - rect.left) / rect.width) * 100
    const clamped = Math.max(15, Math.min(85, percent))
    dom.body.style.setProperty('--split', `${clamped}%`)
    if (editor) editor.refresh()
  }

  const stop = () => {
    if (!dragging) return
    dragging = false
    dom.splitter.classList.remove('dragging')
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', stop)
    if (editor) editor.refresh()
  }

  dom.splitter.addEventListener('mousedown', (event) => {
    event.preventDefault()
    dragging = true
    dom.splitter.classList.add('dragging')
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', stop)
  })
}

/**
 * Opens whatever was dropped. Takes resolved paths rather than a drop event so the
 * smoke test can drive exactly this logic — drag-and-drop is otherwise the one
 * code path that cannot be exercised automatically.
 */
async function handleDroppedPaths(paths) {
  if (paths.length === 0) {
    showToast('Could not read the dropped file path.', 'error')
    return false
  }

  if (!(await guardSwitch())) return false

  // A single item may be a folder. Registering it also tells us which it is:
  // registerDropped stats the path in the main process, where it is not subject
  // to the open-folder scope, unlike fs:stat.
  if (paths.length === 1) {
    const registered = await api.registerDropped(paths[0])
    if (!registered.ok) {
      showToast(registered.error, 'error')
      return false
    }
    if (registered.type === 'dir') {
      await setRoot(paths[0])
      return true
    }
  }

  // Only claim "not a markdown file" when no file was even attempted; otherwise
  // the more specific error from the load is the one worth showing.
  let attempted = false
  let opened = 0

  for (const path of paths) {
    if (!isMarkdownPath(path)) continue
    attempted = true
    if (await loadFile(path)) {
      reconcileTreeWithDocument(path)
      opened += 1
      // Single-file mode replaces the one document, so the first loadable file
      // is all there is. With tabs on, every dropped file gets its own tab.
      if (!state.tabsEnabled) return true
    }
  }

  if (!attempted) {
    showToast('Dropped item is not a markdown file.', 'error')
  }
  return opened > 0
}

function wireDragAndDrop() {
  const stop = (event) => {
    event.preventDefault()
    event.stopPropagation()
  }

  window.addEventListener('dragover', (event) => {
    stop(event)
    event.dataTransfer.dropEffect = 'copy'
  })

  window.addEventListener('drop', async (event) => {
    stop(event)
    const files = Array.from(event.dataTransfer?.files || [])
    if (files.length === 0) return

    // File.path was removed in recent Electron; the preload bridge resolves the
    // real path instead. Without that this array would be full of empty strings.
    const paths = files.map((file) => api.getPathForFile(file)).filter(Boolean)
    await handleDroppedPaths(paths)
  })
}

function wirePreviewLinks() {
  dom.previewHost.addEventListener('click', async (event) => {
    const anchor = event.target.closest('a')
    if (!anchor) return

    const href = anchor.getAttribute('href')
    if (!href) return

    if (href.startsWith('#')) return // in-page anchors are not supported
    event.preventDefault()

    if (isExternalUrl(href)) {
      api.openExternal(href)
      return
    }

    if (isMarkdownPath(href)) {
      const target = resolveRelative(docDir(), href.split('#')[0])
      if (!(await guardSwitch())) return
      await loadFile(target)
      return
    }

    showToast(`Cannot open ${href} from here.`)
  })
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  editor = createEditor({
    parent: dom.editorHost,
    doc: '',
    onChange: (text) => {
      state.text = text
      state.previewStale = true
      refreshDocState()
      schedulePreview()
    },
    onScroll: onEditorScroll
  })

  wireUi()

  const info = await api.init()

  state.tabsEnabled = info.tabs !== false
  renderTabs()

  if (info.lastFolder) {
    await setRoot(info.lastFolder)
  } else {
    renderTree()
  }

  if (info.initialFile) {
    await loadFile(info.initialFile)
  } else {
    renderPreview()
  }

  await setMode(MODES.includes(info.mode) ? info.mode : 'split', { persist: false })
  updateModeButtons()
  refreshDocState()
}

boot().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  showToast(`Startup failed: ${message}`, 'error')
  api.reportError('markdown-reader failed to start', message)
})

// Test hook for scripts/smoke.js. Everything here is also reachable through the
// UI; it exists so the smoke test drives the same modules the app does instead
// of reimplementing them.
window.__mdr = {
  renderMarkdown,
  // Convenience wrapper so the smoke test can assert on the anchor map for a
  // fixture without reaching into marked's lexer.
  lineMapOf: (text) => renderMarkdown(text).lineMap,
  lineToOffset,
  offsetToLine,
  isMonotonic,
  proportionalOffset,
  resolveRelative,
  dirname,
  isMarkdownPath,
  isPathInside,
  isSamePath,
  // Plain data only: this object crosses executeJavaScript back to the test, so
  // it must never carry live CodeMirror state.
  getState: () => {
    const { tabs, ...rest } = state
    return {
      ...rest,
      offsets: null,
      tabs: tabs.map((tab) => ({
        id: tab.id,
        path: tab.docPath,
        name: baseName(tab.docPath),
        dirty: tabIsDirty(tab),
        editable: tab.id === state.activeId ? state.editable : tab.editable
      }))
    }
  },
  getTabs: () =>
    state.tabs.map((tab) => ({
      id: tab.id,
      path: tab.docPath,
      name: baseName(tab.docPath),
      active: tab.id === state.activeId,
      dirty: tabIsDirty(tab),
      editable: tab.id === state.activeId ? state.editable : tab.editable
    })),
  selectTab: async (index) => {
    const tab = state.tabs[index]
    return tab ? activateTabById(tab.id) : false
  },
  closeTabById: (id) => closeTabById(id),
  isTabsEnabled: () => state.tabsEnabled,
  setTabsEnabled: (value) => setTabsEnabledFlow(value),
  // Whether the last View > Tabs transition finished, and with what outcome.
  lastToggle: () => ({ ...lastToggleState }),
  // The guarded open that tree rows, preview links and drops all funnel through,
  // including the single-file mode "unsaved changes?" prompt.
  openPath: async (filePath) => {
    if (!(await guardSwitch())) return false
    return loadFile(filePath)
  },
  // The window-close guard on its own, so the test can drive it repeatedly
  // without destroying the window on the first pass.
  checkDirtyTabs: () => confirmAllDirty(),
  setConfirmHandler: (handler) => {
    confirmHandler = typeof handler === 'function' ? handler : null
  },
  confirmLog: () => confirmLog.slice(),
  loadDocument: async (filePath) => loadFile(filePath, { resetScroll: true }),
  setMode,
  // Appends text through the real CodeMirror change pipeline, so the edit takes
  // the same route as typing: onChange -> dirty tracking -> debounced render.
  typeIntoEditor: (text) => {
    if (!editor) return false
    editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: text } })
    return true
  },
  // The same function the toolbar button and Ctrl+S call.
  save: () => saveFile(),
  closeFile: () => closeFile(),
  toggleEditing: () => toggleEditing(),
  setEditable: (value) => setEditable(value),
  isEditable: () => Boolean(state.editable),
  isContentEditable: () => {
    const content = document.querySelector('.cm-content')
    return content ? content.getAttribute('contenteditable') : null
  },
  undo: () => (editor ? editor.undo() : false),
  redo: () => (editor ? editor.redo() : false),
  setPreviewScroll: (px) => {
    dom.previewHost.scrollTop = Math.max(0, Number(px) || 0)
    return dom.previewHost.scrollTop
  },
  getPreviewScroll: () => dom.previewHost.scrollTop,
  getEditorScroll: () => (editor ? editor.scrollTop() : 0),
  // Drives the real drag-and-drop handling with resolved paths, so the drop path
  // is covered by tests even though a synthetic drop event cannot carry files.
  dropPaths: (paths) => handleDroppedPaths(paths),
  getPreviewHtml: () => dom.previewHost.innerHTML,
  getBlockCount: () => dom.previewHost.querySelectorAll('.md-block').length,
  getEditorText: () => (editor ? editor.getText() : '')
}
