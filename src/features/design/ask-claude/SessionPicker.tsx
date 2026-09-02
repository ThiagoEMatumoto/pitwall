import { useState } from 'react'
import { Plus, TerminalSquare } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Menu, type MenuItem } from '@/components/ui/Menu'
import { ControlPill } from '@/features/brand'
import type { SessionTarget } from './useSessionTargets'

interface Props {
  targets: SessionTarget[]
  value: SessionTarget | null
  onChange: (target: SessionTarget) => void
  onOpenNew: () => void
  disabled?: boolean
}

export function SessionPicker({ targets, value, onChange, onOpenNew, disabled }: Props) {
  const [open, setOpen] = useState(false)

  if (targets.length === 0) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onOpenNew}
        className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)]/60 hover:text-[var(--color-text)] disabled:opacity-50"
      >
        <Icon as={Plus} size={13} />
        Abrir sessão para este design
      </button>
    )
  }

  const items: MenuItem[] = [
    ...targets.map((t) => ({
      label: t.detail ? `${t.label} · ${t.detail}` : t.label,
      active: t.sessionId === value?.sessionId,
      onClick: () => onChange(t),
    })),
    { label: 'Nova sessão para este design…', onClick: onOpenNew },
  ]

  return (
    <Menu open={open} onClose={() => setOpen(false)} items={items} portal align="left">
      <ControlPill
        icon={TerminalSquare}
        caret
        label={value?.label ?? 'Escolher sessão'}
        title={value?.detail ?? undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="max-w-[14rem]"
      />
    </Menu>
  )
}
