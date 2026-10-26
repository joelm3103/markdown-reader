// Injected into the running renderer by scripts/smoke.js and evaluated there.
//
// This is not a module and is never require()'d: smoke.js reads it as text and
// hands it to webContents.executeJavaScript, so it runs inside the real app with
// the real `window.mdapi` bridge and the real window.__mdr test hook.
//
// Inputs arrive on window.__smoke = { fixtureFile, fixtureDir, hostileMarkdown }.
// The final expression resolves to a plain object of observations; assertions
// live in smoke.js so failures are reported in one place.

(async () => {
  const hook = window.__mdr
  const input = window.__smoke
  const out = {}
  const progress = (message) => console.error(`[smoke] payload: ${message}`)

  // Any unsaved-changes prompt that no test queued an answer for is a bug: fail
  // loudly instead of opening a native dialog the harness cannot click (which
  // would hang the run).
  hook.setConfirmHandler((message) => {
    throw new Error(`Unexpected unsaved-changes prompt: ${message}`)
  })

  // --- the empty state must not cover the folder tree -----------------------
  // Regression: it used to be positioned against the viewport, so opening a
  // folder appeared to do nothing until a file was opened and the overlay went
  // away. Measured here with no file open, which is exactly when it is shown.
  const emptyState = document.getElementById('empty-state')
  const sidebar = document.getElementById('sidebar')
  const treeEl = document.getElementById('tree')
  const emptyRect = emptyState.getBoundingClientRect()
  const sidebarRect = sidebar.getBoundingClientRect()
  out.emptyStateDisplayedWithNoFile = getComputedStyle(emptyState).display !== 'none'
  out.emptyStateLeft = Math.round(emptyRect.left)
  out.sidebarRight = Math.round(sidebarRect.right)
  out.emptyStateOverlapsSidebar = emptyRect.left < sidebarRect.right - 1
  out.treeVisibleWithNoFile = treeEl.offsetParent !== null && treeEl.getBoundingClientRect().width > 0
  out.treeRowsWithNoFile = document.querySelectorAll('#tree .tree-row').length
  out.treeFileRowsWithNoFile = document.querySelectorAll('#tree .tree-row.file').length

  // --- the preload bridge (drag-and-drop depends on this) --------------------
  out.hasBridge = typeof window.mdapi === 'object' && window.mdapi !== null
  out.hasWebUtils = Boolean(window.mdapi && window.mdapi.hasWebUtils)
  out.getPathForFileType = typeof (window.mdapi && window.mdapi.getPathForFile)

  // --- rendering + sanitising hostile markdown ------------------------------
  window.__pwned = 0
  const hostile = hook.renderMarkdown(input.hostileMarkdown, { docDir: input.fixtureDir })
  out.hostileHtml = hostile.html
  out.sanitizedBlockCount = hostile.blockCount

  // Inserted into the live document: if an onerror handler or a script had
  // survived sanitisation, it would run now. __pwned is read after this, never
  // before, or the check would be vacuous.
  const hostileContainer = document.createElement('div')
  hostileContainer.style.position = 'fixed'
  hostileContainer.style.left = '-10000px'
  hostileContainer.innerHTML = hostile.html
  document.body.append(hostileContainer)
  await new Promise((resolve) => setTimeout(resolve, 120))

  out.pwned = window.__pwned
  out.hostileSurvivingText = hostileContainer.textContent
  out.hostileHasScriptEl = hostileContainer.querySelectorAll('script').length
  out.hostileHasOnerror = hostileContainer.querySelectorAll('[onerror]').length
  // GFM task list checkboxes must survive the sanitizer, but inert.
  out.hostileCheckboxCount = hostileContainer.querySelectorAll('input[type="checkbox"][disabled]').length
  out.hostileCheckboxEnabled = hostileContainer.querySelectorAll('input[type="checkbox"]:not([disabled])').length
  // A relative image must have been rewritten to the app:// asset route.
  const hostileImg = hostileContainer.querySelector('img')
  out.hostileImgSrc = hostileImg ? hostileImg.getAttribute('src') || '' : ''
  hostileContainer.remove()

  // --- highlighting ---------------------------------------------------------
  const code = hook.renderMarkdown('```js\nconst anchored = 1\n```')
  out.codeHtml = code.html
  out.codeHasTokenSpan = /<span class="hljs-/.test(code.html)
  out.codeHasHljsKeyWord = /hljs-keyword/.test(code.html)
  out.codeNotDoubleEscaped = !/&lt;span/.test(code.html)

  // A fenced block with no language must stay plain: escaped, and untagged.
  const plain = hook.renderMarkdown('```\nplain <text> & such\n```')
  out.plainCodeHtml = plain.html
  out.plainCodeHasTokenSpan = /<span class="hljs-/.test(plain.html)
  out.plainCodeEscaped = /&lt;text&gt;/.test(plain.html)

  // A fenced block nested inside a list item must also be highlighted.
  const nested = hook.renderMarkdown('- item\n\n  ```py\n  print(1)\n  ```\n')
  out.nestedCodeHasTokenSpan = /<span class="hljs-/.test(nested.html)

  // --- the line map, on a small deterministic input -------------------------
  // "# A\n\ntext\n\n## B" -> heading at line 1, paragraph at line 3, heading 5.
  const smallMap = hook.lineMapOf('# A\n\ntext\n\n## B')
  out.smallLines = smallMap.map((entry) => entry.line)
  out.smallTypes = smallMap.map((entry) => entry.type)
  out.smallMonotonic = hook.isMonotonic(smallMap)

  // --- the line map, on the fixture ----------------------------------------
  const fixtureMap = hook.lineMapOf(input.fixtureText)
  out.fixtureBlockCount = fixtureMap.length
  out.fixtureMonotonic = hook.isMonotonic(fixtureMap)
  out.fixtureFirstLine = fixtureMap.length > 0 ? fixtureMap[0].line : -1
  out.fixtureTypes = fixtureMap.map((entry) => entry.type)

  // --- scroll-sync maths (used by scroll sync) -----------------------------
  const fakeOffsets = [0, 100, 300]
  out.lineToOffsetMid = hook.lineToOffset(smallMap, fakeOffsets, 2)
  out.lineToOffsetAtAnchor = hook.lineToOffset(smallMap, fakeOffsets, 3)
  out.offsetToLineAtAnchor = hook.offsetToLine(smallMap, fakeOffsets, 100)
  out.offsetToLineMid = hook.offsetToLine(smallMap, fakeOffsets, 50)
  out.offsetToLineFirst = hook.offsetToLine(smallMap, fakeOffsets, 0)
  out.lineToOffsetNoData = hook.lineToOffset([], [], 5)

  // --- relative path resolution (images and .md links) ----------------------
  out.resolvedSibling = hook.resolveRelative('C:\\notes\\sub', '../other/note.md')
  out.resolvedAbsoluteKept = hook.resolveRelative('C:\\notes', 'D:\\elsewhere\\x.md')
  out.dirnameOf = hook.dirname('C:\\notes\\a\\b.md')

  // --- drive the real app: load a file through IPC and render it -----------
  progress('loading the fixture')
  out.loaded = await hook.loadDocument(input.fixtureFile)
  await new Promise((resolve) => setTimeout(resolve, 250))

  const state = hook.getState()
  out.stateDocPath = state.docPath
  out.stateHasFile = state.hasFile
  out.stateDirty = state.dirty
  out.editorTextLength = hook.getEditorText().length
  out.fixtureTextLength = input.fixtureText.length
  out.editorMatchesFixture = hook.getEditorText() === input.fixtureText
  out.domBlockCount = hook.getBlockCount()
  out.stateBlockCount = state.lineMap.length
  out.stateMonotonic = state.monotonic
  out.mode = document.body.dataset.mode

  // Wrapper order must match map order, and every wrapper must carry its line.
  const wrappers = Array.from(document.querySelectorAll('#preview-host .md-block'))
  const previewBlocks = Array.from(document.querySelectorAll('#preview-host > .md-block'))
  const previewPara = document.querySelector('#preview-host p')
  out.wrapperLines = wrappers.map((node) => Number(node.dataset.line))
  out.mapLines = state.lineMap.map((entry) => entry.line)
  out.wrappersMatchMap =
    wrappers.length === state.lineMap.length &&
    wrappers.every((node, i) => Number(node.dataset.line) === state.lineMap[i].line)

  // Measured block offsets must be ascending, or sync anchors are meaningless.
  const offsets = wrappers.map((node) => node.offsetTop)
  out.offsetsAscending = offsets.every((value, i) => i === 0 || value >= offsets[i - 1])
  out.offsetCount = offsets.length
  out.previewHasHeading = document.querySelectorAll('#preview-host h1').length > 0
  out.previewHasH3 = document.querySelectorAll('#preview-host h3').length > 0
  out.previewHasTable = document.querySelectorAll('#preview-host table').length > 0
  // Real highlighting, not just a container class: the fenced js block must
  // contain highlight.js token spans.
  const previewCode = Array.from(document.querySelectorAll('#preview-host pre code'))
  out.previewCodeBlockCount = previewCode.length
  out.previewHighlightedBlocks = previewCode.filter((node) => node.querySelector('span[class^="hljs-"]')).length
  out.previewScrollHeight = document.querySelector('#preview-host').scrollHeight

  // --- live render spacing: block rhythm and visible rules ------------------
  // Every top-level block lives in its own .md-block wrapper, so the gap between
  // two wrappers is the collapsed vertical margin of their children. These
  // checks pin the comfortable rhythm and rule visibility.
  const luminance = (cssColor) => {
    const [r, g, b] = (cssColor.match(/[\d.]+/g) || ['0', '0', '0']).slice(0, 3).map((value) => {
      const channel = Number(value) / 255
      return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const gapAfter = (index) =>
    Math.round(
      previewBlocks[index + 1].getBoundingClientRect().top -
        previewBlocks[index].getBoundingClientRect().bottom
    )

  out.previewParagraphMargin = previewPara ? getComputedStyle(previewPara).marginBottom : '0px'
  out.previewParagraphMarginNonZero = parseFloat(out.previewParagraphMargin) > 0

  // The fixture puts "### Third level heading" directly above a paragraph.
  const h3Index = previewBlocks.findIndex((node) => node.querySelector('h3'))
  out.headingToTextGap = h3Index >= 0 ? gapAfter(h3Index) : -1
  out.headingGapVisible = out.headingToTextGap >= 8

  // The fixture puts a "---" rule between two blocks.
  const hrIndex = previewBlocks.findIndex((node) => node.querySelector('hr'))
  out.hrGapAbove = hrIndex > 0 ? gapAfter(hrIndex - 1) : -1
  out.hrGapAboveRoomy = out.hrGapAbove >= 16

  const hrEl = document.querySelector('#preview-host hr')
  out.hrLuminanceDelta = hrEl
    ? Math.abs(
        luminance(getComputedStyle(hrEl).borderTopColor) -
          luminance(getComputedStyle(document.body).backgroundColor)
      )
    : -1
  out.hrClearlyVisible = out.hrLuminanceDelta > 0.06

  // --- file tree: lazy, one level at a time --------------------------------
  const treeRows = Array.from(document.querySelectorAll('#tree .tree-row'))
  out.treeRows = treeRows.length
  out.treeDirRows = treeRows.filter((row) => row.classList.contains('dir')).length
  out.treeFileRows = treeRows.filter((row) => row.classList.contains('file')).length
  out.treeLabels = treeRows.map((row) => row.textContent)
  out.folderName = document.getElementById('folder-name').textContent

  // --- live editing: dirty tracking, debounced render, and the real save ---
  progress('live editing and saving')
  out.blocksBeforeEdit = hook.getBlockCount()
  const lineMapBefore = hook.getState().lineMap.length
  out.dirtyBeforeTyping = hook.getState().dirty

  hook.typeIntoEditor('\n\n## Smoke addition\n\nText typed through the editor pipeline.\n')
  // Dirty tracking must be immediate; only the preview render is debounced.
  out.dirtyImmediatelyAfterTyping = hook.getState().dirty
  // The preview renders on a debounce, so give it time to land.
  await new Promise((resolve) => setTimeout(resolve, 600))

  const afterEdit = hook.getState()
  out.dirtyAfterTyping = afterEdit.dirty
  out.textGrew = afterEdit.text.length > input.fixtureText.length
  out.blocksAfterEdit = hook.getBlockCount()
  out.blocksGrew = out.blocksAfterEdit > out.blocksBeforeEdit
  out.lineMapGrew = afterEdit.lineMap.length > lineMapBefore
  out.previewContainsTypedHeading =
    document.querySelectorAll('#preview-host h2').length >
    input.fixtureH2Count
  out.previewContainsTypedText = /Text typed through the editor pipeline\./.test(
    document.querySelector('#preview-host').textContent
  )
  // Scroll anchors must stay usable after a live re-render.
  out.wrappersMatchMapAfterEdit = (() => {
    const wrappers = Array.from(document.querySelectorAll('#preview-host .md-block'))
    const map = hook.getState().lineMap
    return wrappers.length === map.length && wrappers.every((node, i) => Number(node.dataset.line) === map[i].line)
  })()

  // Saving through the app's own save path (toolbar button / Ctrl+S).
  out.saveSucceeded = await hook.save()
  out.dirtyAfterSave = hook.getState().dirty
  out.textOnDiskMarker = 'text typed through the editor pipeline'

  // --- mode switching ------------------------------------------------------
  progress('mode switching')
  await hook.setMode('source')
  out.sourceModeAttr = document.body.dataset.mode
  out.modeButtonCount = document.querySelectorAll('.mode-button').length
  out.modeButtons = Array.from(document.querySelectorAll('.mode-button')).map((b) => b.dataset.mode)
  // There must be no WYSIWYG pane left in the DOM, and no way to reach one.
  out.wysiwygElements = document.querySelectorAll('[data-mode="wysiwyg"], .pane-wysiwyg, #wysiwyg-host, .milkdown, .ProseMirror').length
  out.setModeToWysiwygRejected = await (async () => {
    const before = document.body.dataset.mode
    await hook.setMode('wysiwyg')
    return document.body.dataset.mode === before
  })()

  await hook.setMode('preview')
  out.previewModeAttr = document.body.dataset.mode
  out.previewBlocksInPreviewMode = hook.getBlockCount()

  await hook.setMode('split')
  out.splitModeAttr = document.body.dataset.mode
  out.splitHasSourceAndPreview =
    getComputedStyle(document.querySelector('.pane-source')).display !== 'none' &&
    getComputedStyle(document.querySelector('.pane-preview')).display !== 'none'

  // --- tabs: opening and switching keep documents apart --------------------
  // With tabs enabled (the default) each document keeps its own draft,
  // editability, undo history and reading position; switching never prompts.
  progress('tabs: opening and switching')
  const tabStrip = document.getElementById('tab-strip')
  out.tabsEnabledOnStart = hook.isTabsEnabled()
  out.tabStripVisibleOneTab = !tabStrip.hidden && getComputedStyle(tabStrip).display !== 'none'
  out.tabStripRole = tabStrip.getAttribute('role')
  out.tabNodeCount = tabStrip.querySelectorAll('.tab').length
  out.tabRoleCount = tabStrip.querySelectorAll('.tab[role="tab"]').length
  out.tabAriaSelectedCount = tabStrip.querySelectorAll('.tab[aria-selected="true"]').length
  out.tabsAtStart = hook.getTabs().map((t) => t.name)
  out.closeButtonLabelWithTabs = document.getElementById('btn-close-file').textContent

  out.openedSecondTab = await hook.loadDocument(input.childFile)
  await new Promise((resolve) => setTimeout(resolve, 300))
  out.tabsAfterSecond = hook.getTabs().map((t) => t.name)
  out.activeAfterSecond = (hook.getTabs().find((t) => t.active) || {}).path || ''

  await hook.selectTab(0)
  await new Promise((resolve) => setTimeout(resolve, 250))
  out.activeAfterSwitchBack = (hook.getTabs().find((t) => t.active) || {}).path || ''
  out.editorKeptFirstDoc = hook.getEditorText().includes('Smoke addition')

  hook.typeIntoEditor('TABS-DRAFT-A')
  await new Promise((resolve) => setTimeout(resolve, 300))
  out.dirtyAfterDraftA = hook.getState().dirty
  out.tabDirtyFlagsAfterA = hook.getTabs().map((t) => t.dirty)

  hook.toggleEditing()
  await new Promise((resolve) => setTimeout(resolve, 150))
  out.editableOnFirstTab = hook.isEditable()

  await hook.selectTab(1)
  await new Promise((resolve) => setTimeout(resolve, 300))
  out.editableOnSecondTab = hook.isEditable()
  out.editorOnSecondTab = hook.getEditorText()
  out.childText = input.childText

  hook.typeIntoEditor('TABS-DRAFT-B')
  await new Promise((resolve) => setTimeout(resolve, 300))
  out.tabDirtyFlagsAfterB = hook.getTabs().map((t) => t.dirty)

  await hook.selectTab(0)
  await new Promise((resolve) => setTimeout(resolve, 300))
  out.draftSurvivedSwitch = hook.getEditorText().includes('TABS-DRAFT-A')
  out.dirtyBackOnFirst = hook.getState().dirty
  out.editableBackOnFirst = hook.isEditable()

  out.undoReturnedOnFirst = hook.undo()
  await new Promise((resolve) => setTimeout(resolve, 300))
  out.undoRemovedOwnDraft = !hook.getEditorText().includes('TABS-DRAFT-A')
  out.undoCleanedFirst = hook.getState().dirty === false
  out.otherTabStillDirty = hook.getTabs()[1].dirty === true

  // --- tabs: reading position and "reopening" -----------------------------
  progress('tabs: reading position and reopening')
  out.previewScrollBeforeSwitch = hook.setPreviewScroll(150)
  await hook.selectTab(1)
  await new Promise((resolve) => setTimeout(resolve, 250))
  await hook.selectTab(0)
  await new Promise((resolve) => setTimeout(resolve, 400))
  out.previewScrollAfterSwitch = hook.getPreviewScroll()

  // Opening an already-open file selects its tab: it must not reread the disk
  // and throw away what is in memory.
  hook.typeIntoEditor('KEEP-IN-MEMORY')
  await new Promise((resolve) => setTimeout(resolve, 200))
  out.tabsBeforeReopen = hook.getTabs().length
  out.reopenSelectedExisting = await hook.loadDocument(input.fixtureFile)
  await new Promise((resolve) => setTimeout(resolve, 250))
  out.tabsAfterReopen = hook.getTabs().length
  out.reopenDidNotReread = hook.getEditorText().includes('KEEP-IN-MEMORY')
  out.reopenKeptDirty = hook.getState().dirty === true
  hook.undo() // back to a clean document for the sections below
  await new Promise((resolve) => setTimeout(resolve, 250))

  // --- tabs: closing one asks about its unsaved changes -------------------
  progress('tabs: closing a tab')
  await hook.selectTab(1)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const childTabId = hook.getTabs()[1].id
  out.childDirtyBeforeClose = hook.getTabs()[1].dirty === true

  const cancelQueue = ['cancel']
  hook.setConfirmHandler((message) => {
    const answer = cancelQueue.shift()
    if (!answer) throw new Error(`Unexpected prompt: ${message}`)
    return answer
  })
  out.closeTabCancelled = await hook.closeTabById(childTabId)
  await new Promise((resolve) => setTimeout(resolve, 200))
  out.tabsAfterCancelledClose = hook.getTabs().length
  out.draftKeptAfterCancelledClose = hook.getEditorText().includes('TABS-DRAFT-B')

  hook.setConfirmHandler(() => 'discard')
  out.closeTabAfterDiscard = await hook.closeTabById(childTabId)
  await new Promise((resolve) => setTimeout(resolve, 300))
  out.tabsAfterClosedTab = hook.getTabs().length
  out.activeAfterClosedTab = (hook.getTabs().find((t) => t.active) || {}).name || ''
  hook.setConfirmHandler((message) => {
    throw new Error(`Unexpected unsaved-changes prompt: ${message}`)
  })
  hook.setEditable(false)

  // --- Close File (Ctrl+W) keeps the app and the tree open ------------------
  progress('closing the last tab')
  out.closed = await hook.closeFile()
  await new Promise((resolve) => setTimeout(resolve, 300))

  const closed = hook.getState()
  out.closedDocPath = closed.docPath
  out.closedHasFile = closed.hasFile
  out.closedDirty = closed.dirty
  out.closedTextLength = closed.text.length
  out.closedEditorLength = hook.getEditorText().length
  out.closedPreviewBlocks = hook.getBlockCount()
  out.closedNoFileClass = document.body.classList.contains('no-file')
  out.closedEmptyStateVisible = getComputedStyle(emptyState).display !== 'none'
  out.closedEmptyStateOverlapsSidebar = emptyState.getBoundingClientRect().left < sidebarRect.right - 1
  out.closedTreeFileRows = document.querySelectorAll('#tree .tree-row.file').length
  out.closedTreeDirRows = document.querySelectorAll('#tree .tree-row.dir').length
  out.closedActiveTreeRows = document.querySelectorAll('#tree .tree-row.file.active').length
  out.closedSaveDisabled = document.getElementById('btn-save').disabled
  out.closedCloseDisabled = document.getElementById('btn-close-file').disabled
  out.closedFileName = document.getElementById('file-name').textContent
  // The document is gone but the folder is still browsable: reopening a file
  // from the tree must still work after closing.
  out.reopenedAfterClose = await hook.loadDocument(input.fixtureFile)
  await new Promise((resolve) => setTimeout(resolve, 300))
  out.reopenedBlockCount = hook.getBlockCount()
  out.reopenedHasFile = hook.getState().hasFile
  out.dirtyAfterReopen = hook.getState().dirty
  out.hasFileAfterReopen = hook.getState().hasFile

  // --- dropping files (the real drop handler, driven with resolved paths) ----
  // Last, because dropping a folder changes the tree root. Regression: dropping a
  // file that lives OUTSIDE the opened folder used to fail, because loadFile()
  // read the file before registering it in the allowed path scope, and the
  // resulting refusal was reported as "not a markdown file".
  // A file that belongs to the open tree keeps it, and is marked active.
  progress('drop handling')
  const treeBeforeOwnDrop = document.querySelectorAll('#tree .tree-row').length
  out.dropOwnFolderFile = await hook.dropPaths([input.fixtureFile])
  await new Promise((resolve) => setTimeout(resolve, 300))
  out.treeRowsAfterOwnDrop = document.querySelectorAll('#tree .tree-row').length
  out.treeKeptForOwnFolder = out.treeRowsAfterOwnDrop === treeBeforeOwnDrop && treeBeforeOwnDrop > 0
  out.folderNameAfterOwnDrop = document.getElementById('folder-name').textContent

  // A file from elsewhere must not leave the tree showing an unrelated folder.
  out.dropOutsideFile = await hook.dropPaths([input.outsideFile])
  await new Promise((resolve) => setTimeout(resolve, 300))
  const afterDrop = hook.getState()
  out.droppedDocPath = afterDrop.docPath
  out.droppedExpectedPath = input.outsideFile
  out.droppedFileOpened = afterDrop.hasFile === true
  out.droppedBlocks = hook.getBlockCount()
  out.droppedTextHasContent = afterDrop.text.includes('OUTSIDE-FILE-MARKER')
  out.treeRowsAfterOutsideDrop = document.querySelectorAll('#tree .tree-row').length
  out.folderNameAfterOutsideDrop = document.getElementById('folder-name').textContent
  out.treeHintAfterOutsideDrop = (document.querySelector('#tree .tree-empty') || {}).textContent || ''

  // Dropping several files at once gives each one its own tab; the last one
  // becomes active.
  out.multiDropResult = await hook.dropPaths([input.siblingFile, input.outsideFile])
  await new Promise((resolve) => setTimeout(resolve, 300))
  out.tabsAfterMultiDrop = hook.getTabs().map((t) => t.name)
  out.multiDropActiveLast = (hook.getTabs().find((t) => t.active) || {}).path || ''

  // A dropped file with a non-markdown extension must be refused.
  out.dropNonMarkdown = await hook.dropPaths([input.binaryFile])
  out.stillOpenAfterBadDrop = hook.getState().docPath === input.outsideFile

  // Dropping a folder outside the opened root makes it the new root.
  out.dropOutsideFolder = await hook.dropPaths([input.outsideDir])
  await new Promise((resolve) => setTimeout(resolve, 300))
  out.folderNameAfterDrop = document.getElementById('folder-name').textContent
  out.treeRowsAfterFolderDrop = document.querySelectorAll('#tree .tree-row.file').length

  // --- documents open read-only, editing is opt-in --------------------------
  // A brand-new document (a fresh tab here) always starts read-only.
  progress('read-only, editing toggle, undo/redo')
  await hook.loadDocument(input.freshFile)
  await new Promise((resolve) => setTimeout(resolve, 400))
  out.tabsAfterFreshOpen = hook.getTabs().map((t) => t.name)

  out.readOnlyOnLoad = hook.isEditable() === false
  out.contentEditableOnLoad = hook.isContentEditable()
  out.editingLabelOnLoad = document.getElementById('editing-label').textContent
  out.editingGlyphOnLoad = document.querySelector('#btn-editing .editing-glyph').textContent
  out.editingPressedOnLoad = document.getElementById('btn-editing').getAttribute('aria-pressed')
  out.saveDisabledOnLoad = document.getElementById('btn-save').disabled
  out.originalLength = hook.getEditorText().length

  hook.toggleEditing()
  await new Promise((resolve) => setTimeout(resolve, 250))
  out.editableAfterToggle = hook.isEditable()
  out.contentEditableAfterToggle = hook.isContentEditable()
  out.editingLabelAfterToggle = document.getElementById('editing-label').textContent

  hook.typeIntoEditor('ZZZ-EDIT')
  await new Promise((resolve) => setTimeout(resolve, 400))
  out.dirtyAfterTypingWhenEditable = hook.getState().dirty
  out.saveEnabledAfterTyping = !document.getElementById('btn-save').disabled
  out.editedLength = hook.getEditorText().length

  // Undo/redo must run through CodeMirror's history and feed dirty tracking.
  out.undoReturned = hook.undo()
  await new Promise((resolve) => setTimeout(resolve, 400))
  out.textRevertedByUndo = !hook.getEditorText().includes('ZZZ-EDIT')
  out.undoRestoredOriginal = hook.getEditorText().length === out.originalLength
  out.dirtyAfterUndo = hook.getState().dirty

  out.redoReturned = hook.redo()
  await new Promise((resolve) => setTimeout(resolve, 400))
  out.redoReapplied = hook.getEditorText().includes('ZZZ-EDIT')
  out.dirtyAfterRedo = hook.getState().dirty

  hook.undo()
  await new Promise((resolve) => setTimeout(resolve, 300))
  out.cleanAfterSecondUndo = hook.getState().dirty === false

  // Opening another file must not leave the previous file's history live.
  progress('history isolation')
  await hook.loadDocument(input.outsideFile)
  await new Promise((resolve) => setTimeout(resolve, 400))
  out.readOnlyAfterReopen = hook.isEditable() === false
  out.contentEditableAfterReopen = hook.isContentEditable()
  out.undoReturnedAfterReopen = hook.undo()
  await new Promise((resolve) => setTimeout(resolve, 300))
  out.textAfterUndoOnFreshFile = hook.getEditorText()
  out.outsideContent = input.outsideText

  return out
})()
