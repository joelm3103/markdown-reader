// Race, discard and disk-change checks for scripts/smoke.js.
//
// Injected once per phase. smoke.js sets window.__smokeRacePhase first, and between
// some phases it changes race.md (or child.md's permissions) on disk, because the
// renderer cannot write files itself. Like the other payloads, this returns plain
// observations and leaves the assertions to smoke.js.
//
// The phases run in order against one window and leave only sample.md open at the end.

(async () => {
  const hook = window.__mdr
  const input = window.__smoke
  const phase = window.__smokeRacePhase
  const out = { phase }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const tabs = () => hook.getTabs()
  const tabNamed = (name) => tabs().find((tab) => tab.name === name)
  const activeName = () => (tabs().find((tab) => tab.active) || {}).name || ''
  const nameFromPrompt = (message) => (/"([^"]+)"/.exec(message) || [])[1] || message
  // An unexpected prompt is recorded and answered safely (Cancel / Keep my edits)
  // rather than thrown, so the run reports the surprise instead of dying before
  // the report. smoke.js checks this list is empty for every phase.
  const unexpected = (message, kind) => {
    out.unexpectedPrompts = out.unexpectedPrompts || []
    out.unexpectedPrompts.push(`${kind || '?'}: ${message}`)
    return kind === 'reload' ? 'keep' : 'cancel'
  }

  switch (phase) {
    case 'setup': {
      hook.setConfirmHandler(unexpected)
      const closeButtons = Array.from(document.querySelectorAll('.tab-close'))
      out.closeButtonsOutOfTabOrder = closeButtons.length > 0 && closeButtons.every((button) => button.tabIndex === -1)

      await hook.loadDocument(input.childFile)
      await wait(250)
      out.tabsAtSetup = tabs().map((tab) => tab.name)

      // Rapid switching: two selections are requested before either one finishes.
      // The draft must stay in its own tab, and the other tab must stay clean.
      hook.toggleEditing()
      await wait(150)
      hook.typeIntoEditor('RACE-DRAFT')
      await wait(250)
      await Promise.all([hook.selectTab(0), hook.selectTab(1)])
      await wait(400)
      out.rapidActiveName = activeName()
      out.rapidChildDraftKept = hook.getEditorText().includes('RACE-DRAFT')
      out.rapidChildDirty = tabNamed('child.md')?.dirty
      out.rapidSampleDirty = tabNamed('sample.md')?.dirty

      await hook.selectTab(0)
      await wait(300)
      out.sampleClean = hook.getState().dirty === false && !hook.getEditorText().includes('RACE-DRAFT')
      await hook.selectTab(1)
      await wait(300)
      out.childDraftStillThere = hook.getEditorText().includes('RACE-DRAFT')

      // The same file opened twice at once must produce one tab.
      await Promise.all([hook.loadDocument(input.raceFile), hook.loadDocument(input.raceFile)])
      await wait(300)
      out.raceTabCount = tabs().filter((tab) => tab.name === 'race.md').length
      out.raceActiveName = activeName()
      out.raceEditorMatchesDisk = hook.getEditorText() === input.raceStates.initial

      // Opening a file that is already open in the background selects its tab and
      // keeps its draft, rather than rereading the file.
      await hook.loadDocument(input.childFile)
      await wait(300)
      out.reopenBackgroundName = activeName()
      out.reopenKeptDraft = hook.getEditorText().includes('RACE-DRAFT')
      break
    }

    case 'discard': {
      // race.md is clean. Make it the active tab, edit it, then answer Discard for
      // child.md and Cancel for race.md, so child.md is discarded while the check stops.
      await hook.selectTab(2)
      await wait(300)
      hook.typeIntoEditor('RACE-EDIT-2')
      await wait(250)
      hook.setConfirmHandler((message) => {
        const name = nameFromPrompt(message)
        if (name === 'child.md') return 'discard'
        if (name === 'race.md') return 'cancel'
        return unexpected(message)
      })
      const before = hook.confirmLog().length
      out.guardCancelled = (await hook.checkDirtyTabs()) === false
      out.promptedFor = hook.confirmLog().slice(before).map(nameFromPrompt)

      // Re-selecting the discarded tab must show its saved text, and Save there must
      // write the saved text, not the discarded draft.
      await hook.selectTab(1)
      await wait(300)
      out.discardedShowsSaved = hook.getEditorText() === input.childText
      out.discardedDirty = hook.getState().dirty
      out.saveOnDiscardedOk = await hook.save()
      await wait(200)
      out.editorAfterSave = hook.getEditorText()

      // Discarding the active document keeps it editable.
      await hook.selectTab(2)
      await wait(300)
      hook.toggleEditing()
      await wait(200)
      out.raceEditableBefore = hook.isEditable()
      hook.setConfirmHandler(() => 'discard')
      out.guardDiscardedRace = await hook.checkDirtyTabs()
      await wait(200)
      out.raceEditableAfterDiscard = hook.isEditorEditable()
      out.raceContentEditableAfterDiscard = hook.isContentEditable()
      out.raceTextAfterDiscard = hook.getEditorText() === input.raceStates.initial
      break
    }

    case 'disk-clean-1': {
      // race.md is clean and in the background once this runs. smoke.js then changes it on disk.
      hook.setConfirmHandler(unexpected)
      await hook.selectTab(1)
      await wait(300)
      break
    }

    case 'disk-clean-2': {
      hook.setConfirmHandler(unexpected)
      const before = hook.confirmLog().length
      await hook.selectTab(2)
      await wait(400)
      out.cleanReloaded = hook.getEditorText() === input.raceStates.two
      out.cleanPrompted = hook.confirmLog().length > before
      out.cleanDirty = hook.getState().dirty
      break
    }

    case 'disk-keep-1': {
      // race.md is active and clean. Add local edits, then smoke.js changes the file on disk.
      hook.setConfirmHandler((message, kind) => (kind === 'reload' ? 'keep' : unexpected(message)))
      hook.typeIntoEditor('RACE-LOCAL')
      await wait(250)
      await hook.selectTab(1)
      await wait(300)
      break
    }

    case 'disk-keep-2': {
      const before = hook.confirmLog().length
      await hook.selectTab(2)
      await wait(400)
      out.keepPrompts = hook.confirmLog().length - before
      out.keepKeptEdits = hook.getEditorText().includes('RACE-LOCAL')
      out.keepStillDirty = hook.getState().dirty === true

      // The same disk version must not prompt again on re-selection.
      await hook.selectTab(1)
      await wait(300)
      const middle = hook.confirmLog().length
      await hook.selectTab(2)
      await wait(400)
      out.keepAskedAgain = hook.confirmLog().length > middle
      out.keptAfterReselect = hook.getEditorText().includes('RACE-LOCAL')
      break
    }

    case 'disk-reload-1': {
      // race.md is dirty and in the background. smoke.js then changes it on disk again.
      hook.setConfirmHandler((message, kind) => (kind === 'reload' ? 'reload' : unexpected(message)))
      await hook.selectTab(1)
      await wait(300)
      break
    }

    case 'disk-reload-2': {
      const before = hook.confirmLog().length
      await hook.selectTab(2)
      await wait(400)
      out.reloadPrompts = hook.confirmLog().length - before
      out.reloadedText = hook.getEditorText() === input.raceStates.four
      out.reloadDirty = hook.getState().dirty
      break
    }

    case 'savefail-1': {
      // child.md becomes dirty in the background. smoke.js then makes it read-only.
      hook.setConfirmHandler(unexpected)
      await hook.selectTab(1)
      await wait(300)
      hook.typeIntoEditor('FAIL-EDIT')
      await wait(250)
      await hook.selectTab(2)
      await wait(300)
      out.childDirtyInBackground = tabNamed('child.md')?.dirty
      break
    }

    case 'savefail-2': {
      // Turning tabs off must save child.md, which now fails. The change must be refused.
      hook.setConfirmHandler((message, kind) => (kind === 'unsaved' ? 'save' : unexpected(message)))
      out.toggleOk = await hook.setTabsEnabled(false)
      out.tabsStillOn = hook.isTabsEnabled()
      out.tabsAfterFailedToggle = tabs().map((tab) => tab.name)
      out.childStillDirty = tabNamed('child.md')?.dirty
      break
    }

    case 'concurrent': {
      // The four async races from the second review. Each one drives a save, a
      // prompt or a navigation and another action at the same time, then checks
      // the document each outcome was about.

      // (a) A save and a tab switch at once: the save marks only its own document
      //     clean. A big buffer makes the write outlast the switch.
      await hook.loadDocument(input.childFile)
      await wait(250)
      hook.typeIntoEditor('CONC-B')
      await wait(250)
      await hook.selectTab(0)
      await wait(250)
      hook.typeIntoEditor('CONC-A')
      hook.typeIntoEditor('X'.repeat(1500000))
      await wait(400)
      // The switch is issued first so its IPC lands before the save's: then the
      // save completes after the switch has applied, which is the race.
      await Promise.all([hook.selectTab(1), hook.save()])
      await wait(600)
      out.saveOwnDocClean = tabNamed('sample.md')?.dirty === false
      out.saveOtherStillDirty = tabNamed('child.md')?.dirty === true

      // (b) Edits made while a save is in flight stay unsaved.
      const saving = hook.save()
      hook.typeIntoEditor('CONC-DURING')
      await saving
      await wait(300)
      out.editsDuringSaveStayUnsaved = hook.getState().dirty === true

      // (c) Close Tab closes the document it asked about, even when the user
      //     selects another tab while the save is in flight.
      hook.setConfirmHandler((message, kind) => {
        if (kind === 'unsaved') {
          void hook.selectTab(0)
          return 'save'
        }
        return unexpected(message)
      })
      out.closeRightTabOk = (await hook.closeFile()) === true
      await wait(400)
      out.closeRightTabNames = tabs().map((t) => t.name)
      out.closeRightActiveKept = activeName() === 'sample.md'

      // (d) Tabs off keeps the document that was active when the toggle started,
      //     even when the user selects a closing tab while its prompt is open.
      await hook.loadDocument(input.childFile)
      await wait(250)
      hook.typeIntoEditor('CONC-C')
      await wait(250)
      await hook.selectTab(0)
      await wait(250)
      hook.setConfirmHandler((message, kind) => {
        if (kind === 'unsaved') {
          void hook.selectTab(1)
          return 'save'
        }
        return unexpected(message)
      })
      out.toggleOrphanOk = (await hook.setTabsEnabled(false)) === true
      await wait(400)
      out.toggleOrphanNames = tabs().map((t) => t.name)
      out.toggleOrphanActiveIn = tabs().some((t) => t.active) === true
      out.toggleOrphanActiveName = activeName()
      hook.setConfirmHandler(unexpected)
      out.toggleBackOn = (await hook.setTabsEnabled(true)) === true

      // (e) Closing a tab beats a navigation to it: the closed tab is never shown.
      await hook.loadDocument(input.childFile)
      await wait(250)
      await hook.selectTab(0)
      await wait(250)
      const childId = (tabNamed('child.md') || {}).id
      await Promise.all([hook.selectTab(1), hook.closeTabById(childId)])
      await wait(400)
      out.navCloseNames = tabs().map((t) => t.name)
      out.navCloseActiveIn = tabs().some((t) => t.active) === true

      // Leave one clean document for the close-guard checks that follow.
      if (hook.getState().dirty) await hook.save()
      out.concurrentLeftNames = tabs().map((t) => t.name)
      out.concurrentLeftClean = hook.getState().dirty === false
      break
    }

    case 'cleanup': {
      hook.setConfirmHandler(() => 'discard')
      for (const name of ['child.md', 'race.md']) {
        const tab = tabNamed(name)
        if (tab) await hook.closeTabById(tab.id)
      }
      await wait(300)
      out.tabsAfterCleanup = tabs().map((tab) => tab.name)
      hook.setConfirmHandler(unexpected)
      break
    }

    default:
      throw new Error(`Unknown race phase: ${phase}`)
  }

  return out
})()
