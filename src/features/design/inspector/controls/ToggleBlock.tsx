import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

interface Props {
  label: string
  // Shown dimmed after the label (the active preset).
  hint?: string
  enabled: boolean
  onToggle: (enabled: boolean) => void
  testId?: string
  children: ReactNode
}

// A collapsible sub-block with an on/off switch in its header. Turning it on
// also opens it: the fields appear where the eye already is.
export function ToggleBlock({ label, hint, enabled, onToggle, testId, children }: Props) {
  const [open, setOpen] = useState(enabled)

  useEffect(() => {
    if (enabled) setOpen(true)
  }, [enabled])

  return (
    <div className="rounded-md border border-[var(--color-border)]">
      <div className="flex h-7 items-center gap-1 px-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] text-[var(--color-text)]"
        >
          <Icon as={open ? ChevronDown : ChevronRight} size={12} className="shrink-0 opacity-70" />
          <span className="shrink-0">{label}</span>
          {hint && enabled && (
            <span className="truncate text-[10px] text-[var(--color-text-dim)]">· {hint}</span>
          )}
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${label}: ${enabled ? 'ligado' : 'desligado'}`}
          data-testid={testId}
          onClick={() => onToggle(!enabled)}
          className={`relative h-3.5 w-6 shrink-0 rounded-full transition ${
            enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-surface-2)]'
          }`}
        >
          <span
            className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-[var(--color-bg)] transition ${
              enabled ? 'left-3' : 'left-0.5'
            }`}
          />
        </button>
      </div>
      {open && enabled && <div className="flex flex-col gap-2 px-1.5 pb-2">{children}</div>}
    </div>
  )
}
