import { useEffect } from 'react'
import { useDesignStore } from '@/store/designStore'
import { CanvasStage } from './canvas/CanvasStage'
import { DesignToolbar } from './DesignToolbar'
import { EmptyState } from './EmptyState'
import { Inspector } from './inspector/Inspector'
import { DocsPanel } from './sidebar/DocsPanel'
import { LayersPanel } from './sidebar/LayersPanel'

export function DesignArea() {
  const docId = useDesignStore((s) => s.docId)
  const loadDocs = useDesignStore((s) => s.loadDocs)
  const startWatch = useDesignStore((s) => s.startWatch)
  const stopWatch = useDesignStore((s) => s.stopWatch)

  useEffect(() => {
    void loadDocs()
    startWatch()
    return () => stopWatch()
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
        {docId ? (
          <div key={docId} className="relative min-h-0 flex-1">
            <CanvasStage />
          </div>
        ) : (
          <EmptyState variant="no-doc" />
        )}
      </main>

      {docId && (
        <aside
          key={docId}
          className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <Inspector />
        </aside>
      )}
    </>
  )
}
