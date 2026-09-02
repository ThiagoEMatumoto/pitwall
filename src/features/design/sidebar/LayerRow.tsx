import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Box, ChevronDown, ChevronRight, Eye, EyeOff, Frame, Image, Lock, LockOpen, Shapes, Type } from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import type { ComponentType } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Icon } from '@/components/ui/Icon'
import type { DesignNode, DesignNodeKind } from '@shared/types/design'

export const ROW_HEIGHT = 24
export const INDENT = 14

export interface FlatRow {
  id: string
  node: DesignNode
  depth: number
  parentId: string | null
  hasChildren: boolean
  expanded: boolean
}

const KIND_ICON: Record<DesignNodeKind, ComponentType<LucideProps>> = {
  frame: Frame,
  text: Type,
  image: Image,
  svg: Shapes,
  element: Box,
}

export function rowLabel(node: DesignNode): string {
  if (node.name) return node.name
  if (node.kind === 'text' && node.text) return node.text.slice(0, 40)
  return node.tag
}

interface Props {
  row: FlatRow
  // Overrides row.depth while dragging (projected drop depth).
  depth?: number
  selected: boolean
  hidden: boolean
  locked: boolean
  draggable: boolean
  onSelect: (e: MouseEvent) => void
  onToggleExpand: () => void
  onRename: (name: string) => void
  onToggleHide: () => void
  onToggleLock: () => void
  onHover: (hovering: boolean) => void
}

export function LayerRow({
  row,
  depth,
  selected,
  hidden,
  locked,
  draggable,
  onSelect,
  onToggleExpand,
  onRename,
  onToggleHide,
  onToggleLock,
  onHover,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.id,
    disabled: !draggable,
  })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  function startRename(): void {
    setDraft(row.node.name ?? '')
    setEditing(true)
  }

  function commitRename(): void {
    setEditing(false)
    const next = draft.trim()
    if (next !== (row.node.name ?? '')) onRename(next)
  }

  const indent = (depth ?? row.depth) * INDENT

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        height: ROW_HEIGHT,
        opacity: isDragging ? 0.5 : hidden ? 0.5 : 1,
      }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onClick={onSelect}
      onDoubleClick={(e) => {
        e.stopPropagation()
        startRename()
      }}
      className={`group flex items-center gap-1 pr-1 text-[11px] ${
        selected
          ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
          : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)]/60 hover:text-[var(--color-text)]'
      }`}
      {...attributes}
      {...listeners}
    >
      <span style={{ width: indent }} className="shrink-0" />
      <button
        type="button"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation()
          onToggleExpand()
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className={`flex h-4 w-4 shrink-0 items-center justify-center ${row.hasChildren ? '' : 'invisible'}`}
      >
        <Icon as={row.expanded ? ChevronDown : ChevronRight} size={12} />
      </button>
      <Icon as={KIND_ICON[row.node.kind]} size={12} className="shrink-0 opacity-70" />
      {editing ? (
        <input
          ref={inputRef}
          autoFocus
          value={draft}
          placeholder={rowLabel(row.node)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="h-5 min-w-0 flex-1 rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1 text-[11px] text-[var(--color-text)] outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate" title={rowLabel(row.node)}>
          {rowLabel(row.node)}
        </span>
      )}
      <button
        type="button"
        tabIndex={-1}
        title={locked ? 'Destravar' : 'Travar'}
        onClick={(e) => {
          e.stopPropagation()
          onToggleLock()
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className={`flex h-4 w-4 shrink-0 items-center justify-center ${locked ? '' : 'invisible group-hover:visible'}`}
      >
        <Icon as={locked ? Lock : LockOpen} size={11} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        title={hidden ? 'Mostrar' : 'Ocultar'}
        onClick={(e) => {
          e.stopPropagation()
          onToggleHide()
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className={`flex h-4 w-4 shrink-0 items-center justify-center ${hidden ? '' : 'invisible group-hover:visible'}`}
      >
        <Icon as={hidden ? EyeOff : Eye} size={11} />
      </button>
    </div>
  )
}
