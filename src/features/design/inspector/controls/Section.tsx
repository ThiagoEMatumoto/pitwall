import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

interface Props {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  // Rendered on the right of the header (a toggle, an add button).
  action?: ReactNode
}

export function Section({ title, children, defaultOpen = true, action }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-b border-[var(--color-border)]">
      <div className="flex items-center gap-1 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center gap-1 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-dim)] transition hover:text-[var(--color-text)]"
        >
          <Icon as={open ? ChevronDown : ChevronRight} size={12} />
          {title}
        </button>
        {action}
      </div>
      {open && <div className="flex flex-col gap-2 px-3 pb-3">{children}</div>}
    </section>
  )
}

// Label + control on one row; the inspector is a two-column grid everywhere.
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[64px_1fr] items-center gap-2">
      <span className="truncate text-[11px] text-[var(--color-text-dim)]" title={label}>
        {label}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}
