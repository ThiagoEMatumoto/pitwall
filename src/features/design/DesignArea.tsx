import { useEffect, useRef } from 'react'
import { useDesignStore } from '@/store/designStore'
import { watchAgentFinish } from './AgentActivityToasts'
import { AskClaudeComposer } from './ask-claude/AskClaudeComposer'
import { CanvasStage } from './canvas/CanvasStage'
import { DeleteArtboardDialog } from './DeleteArtboardDialog'
import { useCanvasShortcuts } from './canvas/useCanvasShortcuts'
import { DesignToolbar } from './DesignToolbar'
import { EmptyState } from './EmptyState'
import { Inspector } from './inspector/Inspector'
import { PreviewMode } from './preview/PreviewMode'
import { ShortcutsPanel } from './ShortcutsPanel'
import { DocsPanel } from './sidebar/DocsPanel'
import { LayersPanel } from './sidebar/LayersPanel'

export function DesignArea() {
  const docId = useDesignStore((s) => s.docId)
  const loadDocs = useDesignStore((s) => s.loadDocs)
  const startWatch = useDesignStore((s) => s.startWatch)
  const stopWatch = useDesignStore((s) => s.stopWatch)

  // The hook does not check the area; mounting only under 'design' is the gate.
  useCanvasShortcuts()

  useEffect(() => {
    void loadDocs()
    startWatch()
    const stopFinishWatch = watchAgentFinish()
    return () => {
      stopFinishWatch()
      stopWatch()
    }
  }, [loadDocs, startWatch, stopWatch])

  return (
    <>
      <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex min-h-0 flex-1 flex-col">
          <DocsPanel />
        </div>
        {docId && (
          <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--color-border)]">
            <LayersPanel />
          </div>
        )}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <DesignToolbar />
        {docId ? <CanvasHost key={docId} /> : <EmptyState variant="no-doc" />}
      </main>

      {docId && (
        <aside
          key={docId}
          className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <Inspector />
        </aside>
      )}

      <ShortcutsPanel />
      <PreviewMode />
      <DeleteArtboardDialog />
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
      <AskClaudeComposer />
    </div>
  )
}
