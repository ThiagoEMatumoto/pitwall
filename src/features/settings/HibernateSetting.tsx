import { useEffect, useState } from 'react'
import { sessionsApi } from '@/lib/ipc'
import { useSessionPrefsStore } from '@/lib/session-prefs-store'
import type { HibernateDisabledReason, HibernateStatsView } from '../../../shared/hibernate'

export const HIBERNATE_LABEL = 'Hibernar sessões ociosas após N min (experimental)'
export const HIBERNATE_NEEDS_LAZY_HINT =
  'Requer "Restaurar abas dormindo" ligado: a sessão hibernada volta como aba dormindo.'

const MINUTE_OPTIONS = [0, 60, 120, 240] as const

const DISABLED_REASON_TEXT: Record<HibernateDisabledReason, string> = {
  'lazy-restore-off-at-boot':
    'desligada: as abas dormindo estavam off neste boot (vale após reiniciar)',
  'lazy-restore-off': 'desligada: "Restaurar abas dormindo" está off',
  'after-min-off': 'desligada: tempo = 0',
}

function minuteLabel(min: number): string {
  return min === 0 ? 'Desligado' : `${min} min`
}

export function formatHibernateStats(stats: HibernateStatsView): string {
  const refusals = Object.entries(stats.refusals ?? {})
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${reason}×${n}`)
  const parts = [
    `Hibernadas: ${stats.hibernated ?? 0}`,
    `Recusas: ${refusals.length > 0 ? refusals.join(', ') : 'nenhuma'}`,
  ]
  if (stats.reasonDisabled) parts.push(DISABLED_REASON_TEXT[stats.reasonDisabled])
  return parts.join(' · ')
}

// Escritor da pref sessions.hibernateAfterMin (leitor = tick no main). Só faz
// sentido com o lazy restore: a sessão hibernada vira aba dormindo.
export function HibernateSetting({ open }: { open: boolean }) {
  const lazyRestore = useSessionPrefsStore((s) => s.lazyRestore)
  const afterMin = useSessionPrefsStore((s) => s.hibernateAfterMin)
  const setAfterMin = useSessionPrefsStore((s) => s.setHibernateAfterMin)
  const [stats, setStats] = useState<HibernateStatsView | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    void sessionsApi
      .hibernateStats()
      .then((v) => alive && setStats(v))
      .catch(() => alive && setStats(null))
    return () => {
      alive = false
    }
  }, [open])

  // Valor gravado fora das sugestões (ex.: editado à mão) continua selecionável.
  const options = MINUTE_OPTIONS.includes(afterMin as (typeof MINUTE_OPTIONS)[number])
    ? MINUTE_OPTIONS
    : [...MINUTE_OPTIONS, afterMin].sort((a, b) => a - b)

  return (
    <div className="mt-3 border-t border-[var(--color-border)] pt-3">
      <label className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-[var(--color-text)]">{HIBERNATE_LABEL}</div>
          <div className="text-xs text-[var(--color-text-dim)]">
            {lazyRestore
              ? 'Sessão parada há N min (sem I/O, sem handoff, sem agendamento) sai com /exit e vira aba dormindo; o clique retoma a conversa.'
              : HIBERNATE_NEEDS_LAZY_HINT}
          </div>
        </div>
        <select
          aria-label={HIBERNATE_LABEL}
          value={afterMin}
          disabled={!lazyRestore}
          title={lazyRestore ? undefined : HIBERNATE_NEEDS_LAZY_HINT}
          onChange={(e) => void setAfterMin(Number(e.target.value))}
          className="mt-1 shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-text)] disabled:opacity-50"
        >
          {options.map((min) => (
            <option key={min} value={min}>
              {minuteLabel(min)}
            </option>
          ))}
        </select>
      </label>
      {stats && (
        <div data-testid="hibernate-stats" className="mt-2 text-xs text-[var(--color-text-dim)]">
          {formatHibernateStats(stats)}
        </div>
      )}
    </div>
  )
}
