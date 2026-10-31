import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core'
import { api } from '@/lib/ipc'
import { useDesignStore } from '@/store/designStore'
import { isFolderSection } from '@/store/designStore.hub'
import { AskClaudeComposer } from '../ask-claude/AskClaudeComposer'
import { DragChip } from './DocCard'
import { HubGrid } from './HubGrid'
import { HubHeader } from './HubHeader'
import { HubSidebar } from './HubSidebar'
import { chipFollowsCursor, hubCollisionDetection } from './hub-drag'
import { parseDropId, sectionDocs, sectionTitle, visibleDocs } from './hub-filter'

const DEFAULT_DOC_TITLE = 'Sem título'
// A click on a card must still open it: the drag starts past this distance.
const DRAG_DISTANCE_PX = 6

// Shown when no document is open: sections + folders on the left, the grid of
// the selected section on the right. Dragging a card onto a folder moves it.
export function DesignHub() {
  const docs = useDesignStore((s) => s.docs)
  const archivedDocs = useDesignStore((s) => s.archivedDocs)
  const folders = useDesignStore((s) => s.folders)
  const hubFolder = useDesignStore((s) => s.hubFolder)
  const hubQuery = useDesignStore((s) => s.hubQuery)
  const hubSort = useDesignStore((s) => s.hubSort)
  const loading = useDesignStore((s) => s.loading)
  const error = useDesignStore((s) => s.error)
  const createDoc = useDesignStore((s) => s.createDoc)
  const moveDoc = useDesignStore((s) => s.moveDoc)
  const loadArchived = useDesignStore((s) => s.loadArchived)
  const setAskOpen = useDesignStore((s) => s.setAskOpen)
  const setHubQuery = useDesignStore((s) => s.setHubQuery)

  const [creating, setCreating] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const backfilled = useRef(false)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE_PX } }),
  )

  useEffect(() => {
    // Refs survive StrictMode's instant remount: one backfill per hub mount.
    if (backfilled.current) return
    backfilled.current = true
    void api.design.thumbnailsBackfill().catch(() => undefined)
  }, [])

  useEffect(() => {
    if (hubFolder === 'archived') void loadArchived()
  }, [hubFolder, loadArchived])

  const inSection = useMemo(
    () => sectionDocs(hubFolder, docs, archivedDocs),
    [hubFolder, docs, archivedDocs],
  )
  const shown = useMemo(() => visibleDocs(inSection, hubQuery, hubSort), [inSection, hubQuery, hubSort])
  const dragged = dragId ? docs.find((d) => d.id === dragId) ?? archivedDocs.find((d) => d.id === dragId) : undefined

  const titleOf = (id: string | number) =>
    [...docs, ...archivedDocs].find((d) => d.id === id)?.title ?? 'design'
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Arrastando ${titleOf(active.id)}.`,
    onDragOver: ({ over }) =>
      over?.data.current?.label ? `Sobre ${over.data.current.label}.` : 'Fora de uma pasta.',
    onDragEnd: ({ active, over }) =>
      over?.data.current?.label
        ? `${titleOf(active.id)} movido para ${over.data.current.label}.`
        : 'Solto fora de uma pasta.',
    onDragCancel: () => 'Movimento cancelado.',
  }

  function onDragEnd(e: DragEndEvent): void {
    setDragId(null)
    const target = parseDropId(e.over?.id)
    if (target !== undefined) void moveDoc(String(e.active.id), target)
  }

  async function create(): Promise<void> {
    setCreating(true)
    try {
      await createDoc(DEFAULT_DOC_TITLE, isFolderSection(hubFolder) ? hubFolder : null)
    } catch (err) {
      useDesignStore.setState({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      setCreating(false)
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={hubCollisionDetection}
      accessibility={{ announcements }}
      onDragStart={(e) => setDragId(String(e.active.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragId(null)}
    >
      <HubSidebar />
      {/* The composer docks to this container (no canvas without a document). */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <HubHeader
          title={sectionTitle(hubFolder, folders)}
          count={shown.length}
          creating={creating}
          onCreate={() => void create()}
        />
        {error && (
          <div role="alert" className="flex items-center gap-2 px-6 pt-3 text-xs text-[var(--color-danger)]">
            <span className="min-w-0 truncate">{error}</span>
            <button
              type="button"
              onClick={() => useDesignStore.setState({ error: null })}
              className="shrink-0 rounded underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            >
              Dispensar
            </button>
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <HubGrid
            section={hubFolder}
            docs={shown}
            sectionCount={inSection.length}
            query={hubQuery}
            loading={loading}
            onCreate={() => void create()}
            onAsk={() => setAskOpen(true)}
            onClearQuery={() => setHubQuery('')}
          />
        </div>
        <AskClaudeComposer />
      </main>
      <DragOverlay dropAnimation={null} modifiers={[chipFollowsCursor]}>{dragged ? <DragChip doc={dragged} /> : null}</DragOverlay>
    </DndContext>
  )
}
