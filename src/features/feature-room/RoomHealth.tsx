import { LivenessChip } from '@/features/features/LivenessChip'
import type { RoomSnapshot } from '../../../shared/types/feature-room'

// Texto do chip de wakes. Sem tentativa em 24h não há % a mostrar.
export function wakesText(w: RoomSnapshot['wakeHealth']): string {
  if (w.attempted === 0) return 'sem avisos à mãe em 24h'
  const pct = Math.round((100 * w.delivered) / w.attempted)
  const missing = w.missing > 0 ? ` · ${w.missing} sem tentativa` : ''
  return `wakes entregues 24h · ${w.delivered}/${w.attempted} (${pct}%)${missing}`
}

// Faixa de saúde: liveness da frente, pulso atual e entregas de wake à mãe.
export function RoomHealth({ snapshot }: { snapshot: RoomSnapshot }) {
  const { loop, wakeHealth } = snapshot
  return (
    <div className="flex min-h-[34px] items-center gap-3.5 border-b border-[var(--color-border)] px-4 py-[7px] text-[12.5px] text-[var(--color-text-dim)]">
      <LivenessChip liveness={loop.liveness} issues={loop.issues} />
      <span
        className="min-w-0 flex-1 truncate text-[var(--color-text)]"
        data-testid="room-pulse"
        title={loop.pulse?.body}
      >
        {loop.pulse ? (
          loop.pulse.body
        ) : (
          <span className="text-[var(--color-text-dim)]">
            Sem pulso ainda. A mãe escreve o primeiro ao pegar a feature.
          </span>
        )}
      </span>
      <span
        data-testid="room-wakes"
        className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-[var(--color-border)] px-2 py-px text-[11.5px] tabular-nums"
        title={`${wakeHealth.delivered} de ${wakeHealth.attempted} avisos à mãe entregues nas últimas 24h`}
      >
        {wakesText(wakeHealth)}
      </span>
    </div>
  )
}
