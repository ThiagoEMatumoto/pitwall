import type { Liveness, LoopIssue } from '../../../shared/feature-loop'
import { LIVENESS_META } from './status'

const DAY_MS = 24 * 60 * 60 * 1000

interface Props {
  liveness: Liveness
  /** Maior timestamp de atividade real (do snapshot) — vira o "há N dias". */
  lastActivityAt?: number | null
  issues?: readonly LoopIssue[]
  now?: number
}

export function daysSince(ts: number, now: number): number {
  return Math.max(0, Math.floor((now - ts) / DAY_MS))
}

function activityPhrase(lastActivityAt: number | null | undefined, now: number): string | null {
  if (typeof lastActivityAt !== 'number') return null
  const days = daysSince(lastActivityAt, now)
  if (days === 0) return 'tocada hoje'
  if (days === 1) return 'sem atividade há 1 dia'
  return `sem atividade há ${days} dias`
}

// O liveness é derivado, então o chip precisa dizer de onde veio — sem isso o
// usuário lê um veredito sem premissa. Cada valor explica a SUA causa: 'broken'
// pela issue que o causou, 'quiet'/'alive' pelo tempo desde o último toque.
export function livenessReason(
  liveness: Liveness,
  lastActivityAt: number | null | undefined,
  issues: readonly LoopIssue[] = [],
  now: number = Date.now(),
): string {
  const activity = activityPhrase(lastActivityAt, now)
  switch (liveness) {
    case 'broken': {
      const first = issues.find((i) => i.level === 'error')
      return first ? `Quebrado: ${first.message}` : 'Quebrado: dado do loop inconsistente.'
    }
    case 'paused':
      return 'Pausado: a cadência não é cobrada enquanto a frente estiver parada.'
    case 'done':
      return 'Concluído: o loop parou porque a frente terminou.'
    case 'quiet':
      return activity ? `Silêncio: ${activity}.` : 'Silêncio: ninguém tocou a frente na cadência esperada.'
    case 'alive':
      return activity ? `Vivo: ${activity}.` : 'Vivo: tocada dentro da cadência esperada.'
  }
}

// Mesma receita visual do StatusBadge (pill + color-mix do token), um passo
// acima em tamanho/peso: liveness é o que se lê primeiro no header.
export function LivenessChip({ liveness, lastActivityAt, issues, now }: Props) {
  const meta = LIVENESS_META[liveness]
  const reason = livenessReason(liveness, lastActivityAt, issues, now ?? Date.now())
  return (
    <span
      data-testid="liveness-chip"
      data-liveness={liveness}
      title={reason}
      aria-label={`vitalidade: ${meta.label}`}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold"
      style={{
        color: meta.color,
        borderColor: `color-mix(in srgb, ${meta.color} 45%, transparent)`,
        background: `color-mix(in srgb, ${meta.color} 12%, transparent)`,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  )
}
