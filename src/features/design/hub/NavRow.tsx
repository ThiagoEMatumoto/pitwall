import type { ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { activeMarker, cx } from '@/features/brand'

// One sidebar entry. With `dropId` it accepts a dragged card; `label` is what
// the drag announcements read out.
export function NavRow({
  dropId,
  active,
  onSelect,
  leading,
  label,
  count,
  trailing,
}: {
  dropId?: string
  active: boolean
  onSelect: () => void
  leading: ReactNode
  label: string
  count?: number
  trailing?: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: dropId ?? `nav:${label}`,
    disabled: !dropId,
    data: { label },
  })
  return (
    <div
      ref={setNodeRef}
      data-drop-over={isOver || undefined}
      className={cx(
        'group relative flex items-center rounded-md transition-colors duration-150',
        isOver
          ? 'bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-[var(--color-text)] ring-1 ring-inset ring-[var(--color-accent)]/70'
          : active
            ? `bg-[var(--color-surface-2)] text-[var(--color-text)] ${activeMarker}`
            : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)]/60 hover:text-[var(--color-text)]',
      )}
    >
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        {leading}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count !== undefined && (
          <span className="shrink-0 text-[11px] tabular-nums opacity-70">{count}</span>
        )}
      </button>
      {trailing}
    </div>
  )
}
