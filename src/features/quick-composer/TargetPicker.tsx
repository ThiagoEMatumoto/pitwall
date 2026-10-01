import { useEffect, useMemo, useRef, useState } from 'react'
import { SessionPill } from '@/features/sessions/MentionMenu'
import { searchTargets, type SendTarget } from './target-search'

interface Props {
  targets: SendTarget[]
  onPick: (t: SendTarget) => void
  onCancel: () => void
}

// Seletor de destino: toda sessão viva de todos os projetos, com a linha de
// propósito quando existir. Encerradas não entram (não há PTY pra receber).
export function TargetPicker({ targets, onPick, onCancel }: Props) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useMemo(() => searchTargets(query, targets), [query, targets])

  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => setActive(0), [query])

  return (
    <div data-testid="target-picker" className="flex flex-col gap-1">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar sessão por nome, projeto ou propósito…"
        aria-label="Buscar sessão de destino"
        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const n = results.length
            if (n > 0) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (results[active]) onPick(results[active])
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      {results.length === 0 ? (
        <p className="px-1 py-2 text-xs text-[var(--color-text-dim)]">
          Nenhuma sessão viva casa com “{query}” — sessões encerradas não aparecem
        </p>
      ) : (
        <ul role="listbox" aria-label="Sessões vivas" className="max-h-56 overflow-auto">
          {results.map((t, i) => (
            <li
              key={t.sessionId}
              role="option"
              aria-selected={i === active}
              data-testid="target-option"
              data-alias={t.alias}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(t)
              }}
              className={`flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-xs ${
                i === active ? 'bg-[var(--color-surface)]' : ''
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <SessionPill target={t} />
                <span className="min-w-0 truncate text-[var(--color-text)]">{t.label}</span>
                <span className="ml-auto shrink-0 text-[var(--color-text-dim)]">
                  {t.projectName ?? 'Avulsa'}
                </span>
              </span>
              {t.purpose && (
                <span className="truncate pl-1 text-[var(--color-text-dim)]">{t.purpose}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
