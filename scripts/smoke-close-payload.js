// Second injected payload for scripts/smoke.js: the window-close guard.
//
// Runs after the main payload and after the View > Tabs toggle checks. It sets
// up two dirty documents in different tabs, then drives the same guard the
// window 'close' event uses, first with a Cancel answer (the close must be
// stopped) and then with Discard (it must proceed). Finally it leaves two
// documents dirty with a Discard handler installed, so smoke.js can close the
// real window afterwards and watch the app resolve them.
//
// Same rules as smoke-payload.js: no modules, assertions live in smoke.js.

(async () => {
  const hook = window.__mdr
  const input = window.__smoke
  const out = {}
  const progress = (message) => console.error(`[smoke] close payload: ${message}`)

  // Unqueued prompts must fail the run, never open a native dialog.
  hook.setConfirmHandler((message) => {
    throw new Error(`Unexpected unsaved-changes prompt: ${message}`)
  })

  // Tabs after the toggle checks: one document, which is kept as the active
  // one. Two more become the dirty pair.
  await hook.loadDocument(input.freshFile)
  await new Promise((resolve) => setTimeout(resolve, 300))
  await hook.loadDocument(input.siblingFile)
  await new Promise((resolve) => setTimeout(resolve, 300))
  out.tabsBeforeGuard = hook.getTabs().map((t) => t.name)
  progress('tabs ready')

  hook.typeIntoEditor('QUIT-DIRTY-A')
  await new Promise((resolve) => setTimeout(resolve, 250))
  await hook.selectTab(1) // fresh.md
  await new Promise((resolve) => setTimeout(resolve, 250))
  hook.typeIntoEditor('QUIT-DIRTY-B')
  await new Promise((resolve) => setTimeout(resolve, 250))
  out.dirtyBeforeGuard = hook.getTabs().map((t) => t.dirty)
  progress('running the guard with a cancel')

  // Cancel on the second prompt stops the whole close: the app must not close
  // over a document whose prompt was never resolved.
  const logStart = hook.confirmLog().length
  const cancelQueue = ['discard', 'cancel']
  hook.setConfirmHandler((message) => {
    const answer = cancelQueue.shift()
    if (!answer) throw new Error(`Unexpected prompt: ${message}`)
    return answer
  })
  out.guardAfterCancel = await hook.checkDirtyTabs()
  out.promptsAfterCancel = hook.confirmLog().slice(logStart)
  out.dirtyAfterCancelledGuard = hook.getTabs().map((t) => t.dirty)
  progress('running the guard with discard')

  // Both documents answered with Discard: the guard lets the close proceed.
  hook.typeIntoEditor('QUIT-DIRTY-C')
  await new Promise((resolve) => setTimeout(resolve, 250))
  const logMid = hook.confirmLog().length
  hook.setConfirmHandler(() => 'discard')
  out.guardAfterDiscard = await hook.checkDirtyTabs()
  out.promptsAfterDiscard = hook.confirmLog().slice(logMid)
  out.dirtyAfterDiscardGuard = hook.getTabs().map((t) => t.dirty)
  progress('leaving two documents dirty')

  // Leave two documents dirty with the Discard handler installed. smoke.js then
  // closes the real window: the guard must prompt for both and let it close.
  hook.typeIntoEditor('QUIT-DIRTY-D')
  await new Promise((resolve) => setTimeout(resolve, 200))
  await hook.selectTab(2) // sibling.md
  await new Promise((resolve) => setTimeout(resolve, 200))
  hook.typeIntoEditor('QUIT-DIRTY-E')
  await new Promise((resolve) => setTimeout(resolve, 250))
  out.dirtyAtEnd = hook.getTabs().map((t) => t.dirty)
  progress('done')

  return out
})()
