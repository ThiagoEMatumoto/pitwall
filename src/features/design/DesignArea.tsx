import { useEffect, useRef } from 'react'
import { useDesignStore } from '@/store/designStore'
import { watchAgentFinish } from './AgentActivityToasts'
import { AskClaudeComposer } from './ask-claude/AskClaudeComposer'
import { CanvasStage } from './canvas/CanvasStage'
import { ChangesSinceVisit } from './canvas/ChangesSinceVisit'
import { DeleteArtboardDialog } from './DeleteArtboardDialog'
import { useCanvasShortcuts } from './canvas/useCanvasShortcuts'
import { DesignToolbar } from './DesignToolbar'
import { DesignHub } from './hub/DesignHub'
import { Inspector } from './inspector/Inspector'
import { PreviewMode } from './preview/PreviewMode'
import { ShortcutsPanel } from './ShortcutsPanel'
import { DesignBreadcrumb } from './sidebar/DesignBreadcrumb'
import { DocsPanel } from './sidebar/DocsPanel'
import { LayersPanel } from './sidebar/LayersPanel'

export function DesignArea() {
  const docId = useDesignStore((s) => s.docId)
  const loadDocs = useDesignStore((s) => s.loadDocs)
  const loadFolders = useDesignStore((s) => s.loadFolders)
  const startWatch = useDesignStore((s) => s.startWatch)
  const stopWatch = useDesignStore((s) => s.stopWatch)
  const resyncDoc = useDesignStore((s) => s.resyncDoc)
  const hydrateLive = useDesignStore((s) => s.hydrateLive)
  const markSeen = useDesignStore((s) => s.markSeen)

  // The hook does not check the area; mounting only under 'design' is the gate.
  useCanvasShortcuts()

  useEffect(() => {
    // Watch first, then fetch: nothing broadcast meanwhile slips between them.
    startWatch()
    const stopFinishWatch = watchAgentFinish()
    void loadDocs()
    void loadFolders()
    // Back from another area with a document still open: its tree is stale.
    if (useDesignStore.getState().docId) void resyncDoc()
    // Leaving counts as having seen the open document only once its "since
    // your visit" list was computed — StrictMode's instant remount is not a visit.
    let hydrated = false
    void hydrateLive().then(() => {
      hydrated = true
    })
    return () => {
      stopFinishWatch()
      stopWatch()
      const openId = useDesignStore.getState().docId
      if (hydrated && openId) markSeen(openId)
    }
  }, [loadDocs, loadFolders, startWatch, stopWatch, resyncDoc, hydrateLive, markSeen])

  const overlays = (
    <>
      <ShortcutsPanel />
      <PreviewMode />
      <DeleteArtboardDialog />
    </>
  )

  if (!docId) {
    return (
      <>
        <DesignHub />
        {overlays}
      </>
    )
  }

  return (
    <>
      <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <DesignBreadcrumb />
        <div className="flex min-h-0 flex-1 flex-col">
          <DocsPanel />
        </div>
        <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--color-border)]">
          <LayersPanel />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <DesignToolbar />
        <CanvasHost key={docId} />
      </main>

      <aside
        key={docId}
        className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-surface)]"
      >
        <Inspector />
      </aside>

      {overlays}
    </>
  )
}

function CanvasHost() {
  const hostRef = useRef<HTMLDivElement>(null)

  // A text edit leaves keyboard focus inside the iframe; the runtime forwards
  // only Escape/Cmd+Enter, so the rest of the keymap needs focus back here.
  useEffect(
    () =>
      useDesignStore.subscribe((s, prev) => {
        if (prev.textEditing && !s.textEditing) hostRef.current?.focus()
      }),
    [],
  )

  return (
    <div ref={hostRef} tabIndex={-1} className="relative min-h-0 flex-1 outline-none">
      <CanvasStage />
      <ChangesSinceVisit />
      <AskClaudeComposer />
    </div>
  )
}
