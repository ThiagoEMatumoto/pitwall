import { useState } from 'react'
import { AlertTriangle, ChevronRight, Settings } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { fmtTokens } from '../../overview/usage-format'

interface Props {
  label: string
  detail: string
  level: 'info' | 'warning' | 'error'
  // Só preenchidos no compact_boundary quando o transcript grava compactMetadata.
  trigger?: string
  preTokens?: number
  postTokens?: number
  defaultOpen?: boolean
}

const LEVEL_COLOR: Record<Props['level'], string> = {
  info: 'text-[var(--color-text-dim)]',
  warning: 'text-[var(--color-warning,var(--color-accent))]',
  error: 'text-[var(--color-danger)]',
}

const TRIGGER_LABEL: Record<string, string> = { auto: 'automática', manual: 'manual' }

// Contexto de sistema CURADO: chip discreto centralizado entre as mensagens.
// Colapsado salvo `defaultOpen` (recap) — nunca despeja conteúdo cru inline.
export function SystemCard({ label, detail, level, trigger, preTokens, postTokens, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  const color = LEVEL_COLOR[level]
  const showsMore = detail.trim() !== '' && detail.trim() !== label.trim()
  const suffix = [
    trigger && (TRIGGER_LABEL[trigger] ?? trigger),
    preTokens != null && postTokens != null && `${fmtTokens(preTokens)}→${fmtTokens(postTokens)}`,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="flex justify-center">
      <div className="max-w-[85%] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/40 text-xs">
        <button
          type="button"
          onClick={() => showsMore && setOpen((o) => !o)}
          className={`flex w-full items-center gap-1.5 px-2 py-1 text-left ${color} ${
            showsMore ? '' : 'cursor-default'
          }`}
        >
          {showsMore && (
            <Icon
              as={ChevronRight}
              size={11}
              className={`shrink-0 transition ${open ? 'rotate-90' : ''}`}
            />
          )}
          <Icon as={level === 'error' ? AlertTriangle : Settings} size={11} className="shrink-0" />
          <span className="font-medium">{label}</span>
          {suffix && <span className="text-[var(--color-text-dim)]">· {suffix}</span>}
        </button>
        {open && showsMore && (
          <div className="whitespace-pre-wrap break-words border-t border-[var(--color-border)] px-2 py-1.5 text-[var(--color-text-dim)]">
            {detail}
          </div>
        )}
      </div>
    </div>
  )
}
