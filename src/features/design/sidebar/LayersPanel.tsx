import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Search } from 'lucide-react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Icon } from '@/components/ui/Icon'
import { getBridge, getNodeIndex, useDesignStore } from '@/store/designStore'
import type { DesignNode } from '@shared/types/design'
import { getStyle } from '../inspector/style-mapping'
import { INDENT, LayerRow, ROW_HEIGHT, rowLabel, type FlatRow } from './LayerRow'
import { useWindowedRows } from './useWindowedRows'

const CONTAINER_KINDS = new Set(['frame', 'element'])

function flatten(tree: DesignNode, rootName: string, expanded: ReadonlySet<string>, query: string): FlatRow[] {
  const rows: FlatRow[] = []
  const q = query.trim().toLowerCase()
  const visit = (node: DesignNode, depth: number, parentId: string | null): void => {
    const open = depth === 0 || expanded.has(node.id)
    const label = rowLabel(node, depth === 0 ? rootName : undefined)
    const matches = !q || label.toLowerCase().includes(q) || (node.text ?? '').toLowerCase().includes(q)
    if (matches) {
      rows.push({ id: node.id, node, label, depth, parentId, hasChildren: node.children.length > 0, expanded: open })
    }
    // A search shows every match regardless of collapse state.
    if (open || q) for (const child of node.children) visit(child, depth + 1, node.id)
  }
  visit(tree, 0, null)
  return rows
}

function ancestorsOf(artboardId: string, nodeId: string): string[] {
  const index = getNodeIndex(artboardId)
  const out: string[] = []
  let cur = index?.get(nodeId)?.parentId ?? null
  while (cur) {
    out.push(cur)
    cur = index?.get(cur)?.parentId ?? null
  }
  return out
}

interface Projection {
  depth: number
  parentId: string
  index: number
}

// dnd-kit's sortable is flat; the drop depth is projected from the pointer's
// x offset, bounded by the rows that end up above and below the active one.
function project(rows: FlatRow[], activeId: string, overId: string, offsetX: number): Projection | null {
  const activeIndex = rows.findIndex((r) => r.id === activeId)
  const overIndex = rows.findIndex((r) => r.id === overId)
  if (activeIndex === -1 || overIndex === -1) return null
  const moved = arrayMove(rows, activeIndex, overIndex)
  const prev = moved[overIndex - 1]
  const next = moved[overIndex + 1]
  if (!prev) return null
  const maxDepth = CONTAINER_KINDS.has(prev.node.kind) ? prev.depth + 1 : prev.depth
  const minDepth = Math.max(1, next ? next.depth : 1)
  const depth = Math.max(minDepth, Math.min(maxDepth, rows[activeIndex].depth + Math.round(offsetX / INDENT)))
  let parentId: string | null = null
  for (let i = overIndex - 1; i >= 0; i--) {
    if (moved[i].depth === depth - 1) {
      parentId = moved[i].id
      break
    }
  }
  if (!parentId) return null
  let index = 0
  for (let i = overIndex - 1; i >= 0 && moved[i].depth >= depth; i--) {
    if (moved[i].depth === depth && moved[i].parentId === parentId) index++
  }
  return { depth, parentId, index }
}

export function LayersPanel() {
  const selection = useDesignStore((s) => s.selection)
  const pageId = useDesignStore((s) => s.pageId)
  const artboards = useDesignStore((s) => s.artboards)
  const lockedIds = useDesignStore((s) => s.lockedIds)
  const select = useDesignStore((s) => s.select)
  const setHover = useDesignStore((s) => s.setHover)
  const commit = useDesignStore((s) => s.commit)
  const toggleLock = useDesignStore((s) => s.toggleLock)

  const artboardId =
    selection.artboardId ??
    Object.values(artboards)
      .map((a) => a.meta)
      .filter((m) => m.pageId === pageId)
      .sort((a, b) => a.position - b.position)[0]?.id ??
    null
  const tree = artboardId ? artboards[artboardId]?.tree : undefined
  const artboardName = artboardId ? (artboards[artboardId]?.meta.name ?? '') : ''

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [drag, setDrag] = useState<{ activeId: string; overId: string | null; offsetX: number } | null>(null)

  const rows = useMemo(
    () => (tree ? flatten(tree, artboardName, expanded, query) : []),
    [tree, artboardName, expanded, query],
  )
  // While dragging, the active subtree collapses so it cannot be dropped into itself.
  const visibleRows = useMemo(() => {
    if (!drag) return rows
    const hidden = new Set<string>()
    for (const r of rows) if (r.id === drag.activeId || (r.parentId && hidden.has(r.parentId))) hidden.add(r.id)
    return rows.filter((r) => r.id === drag.activeId || !hidden.has(r.id))
  }, [rows, drag])

  const win = useWindowedRows(visibleRows.length, ROW_HEIGHT, 10)
  const selected = useMemo(() => new Set(selection.nodeIds), [selection.nodeIds])

  // Canvas → layers: reveal and scroll to the first selected node.
  useEffect(() => {
    const first = selection.nodeIds[0]
    if (!first || !selection.artboardId) return
    const ancestors = ancestorsOf(selection.artboardId, first)
    setExpanded((prev) => {
      if (ancestors.every((a) => prev.has(a))) return prev
      return new Set([...prev, ...ancestors])
    })
    const i = rows.findIndex((r) => r.id === first)
    if (i >= 0) win.scrollToRow(i)
    // `expanded` is read but deliberately not a dependency: it changes right
    // above and the effect re-runs through `rows`.
  }, [selection.artboardId, selection.nodeIds, rows, win.scrollToRow])

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const projection = drag?.overId && artboardId ? project(visibleRows, drag.activeId, drag.overId, drag.offsetX) : null

  function onDragStart(e: DragStartEvent): void {
    setDrag({ activeId: String(e.active.id), overId: null, offsetX: 0 })
  }

  function onDragMove(e: DragMoveEvent): void {
    setDrag((d) => (d ? { ...d, overId: e.over ? String(e.over.id) : null, offsetX: e.delta.x } : d))
  }

  function onDragEnd(e: DragEndEvent): void {
    const active = String(e.active.id)
    const over = e.over ? String(e.over.id) : null
    const p = over && artboardId ? project(visibleRows, active, over, e.delta.x) : null
    setDrag(null)
    if (!p || !artboardId) return
    const current = getNodeIndex(artboardId)?.get(active)
    const parent = p.parentId ? getNodeIndex(artboardId)?.get(p.parentId)?.node : undefined
    const currentIndex = parent?.children.findIndex((c) => c.id === active) ?? -1
    if (current?.parentId === p.parentId && currentIndex === p.index) return
    commit(artboardId, [{ type: 'move', ids: [active], parentId: p.parentId, index: p.index }])
    setExpanded((prev) => new Set([...prev, p.parentId]))
  }

  function onSelectRow(row: FlatRow, e: MouseEvent): void {
    if (!artboardId) return
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      const ids = selected.has(row.id) ? selection.nodeIds.filter((id) => id !== row.id) : [...selection.nodeIds, row.id]
      select(artboardId, ids)
    } else {
      select(artboardId, row.depth === 0 ? [] : [row.id])
    }
  }

  function onHoverRow(row: FlatRow, hovering: boolean): void {
    if (!artboardId) return
    if (!hovering) {
      setHover(null)
      return
    }
    const rect = getBridge(artboardId)?.getCachedRect(row.id)
    if (rect) setHover({ artboardId, nodeId: row.id, rect })
  }

  if (!artboardId || !tree) {
    return (
      <div className="px-3 py-3 text-[11px] text-[var(--color-text-dim)]">Nenhum artboard nesta página.</div>
    )
  }

  const slice = visibleRows.slice(win.start, win.end)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-2 py-1.5">
        <Icon as={Search} size={12} className="text-[var(--color-text-dim)]" />
        <input
          type="text"
          value={query}
          placeholder="Buscar camadas"
          onChange={(e) => setQuery(e.target.value)}
          className="h-5 min-w-0 flex-1 bg-transparent text-[11px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)]"
        />
      </div>
      <div ref={win.ref} onScroll={win.onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDrag(null)}
        >
          <SortableContext items={visibleRows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
            <div style={{ height: win.topPad }} />
            {slice.map((row) => (
              <LayerRow
                key={row.id}
                row={row}
                depth={drag?.activeId === row.id && projection ? projection.depth : undefined}
                selected={selected.has(row.id)}
                hidden={!!row.node.hidden || getStyle(row.node.style, 'display') === 'none'}
                locked={!!lockedIds[row.id]}
                draggable={row.depth > 0 && !query && !lockedIds[row.id]}
                onSelect={(e) => onSelectRow(row, e)}
                onToggleExpand={() => toggleExpand(row.id)}
                onRename={(name) => commit(artboardId, [{ type: 'rename', id: row.id, name }])}
                onToggleHide={() =>
                  commit(artboardId, [
                    {
                      type: 'setStyle',
                      id: row.id,
                      patch: { display: getStyle(row.node.style, 'display') === 'none' ? null : 'none' },
                    },
                  ])
                }
                onToggleLock={() => toggleLock(row.id)}
                onHover={(h) => onHoverRow(row, h)}
              />
            ))}
            <div style={{ height: win.bottomPad }} />
          </SortableContext>
        </DndContext>
      </div>
    </div>
  )
}
