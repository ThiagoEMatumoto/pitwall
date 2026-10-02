import { RefreshCw } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { ApexDot, GradientBorder } from '@/features/brand'
import { useAppStore } from '@/store/appStore'
import { groupLiveSessions } from '../../../shared/home-selectors'
import type { OverviewCounts } from '../../../shared/types/ipc'

// Hero da Home (design Pitwall): moldura de borda-gradiente + glow radial no
// topo. Saudação com headline viva ("N agentes em pista"), data por extenso +
// contexto de decisão, pills de estado (no box / em pista) e chips-stat dos
// contadores do agregado. Voz de engenheiro de pista.
export function HomeHero({ counts, onRefresh }: { counts: OverviewCounts; onRefresh: () => void }) {
  // TODA sessão viva, inclusive a filha no Crew Dock: o hero responde "alguém
  // precisa de mim?". Com a equipe de fora, uma filha esperando permissão virava
  // "garagem tranquila · 0 no box" enquanto o dock dizia "1 esperando".
  const liveSessions = useAppStore((s) => s.liveSessions)
  const groups = groupLiveSessions(liveSessions)
  const inBox = groups.waiting.length
  const onTrack = groups.working.length
  const now = new Date()

  return (
    <GradientBorder
      radius={17}
      style={{ display: 'block', width: '100%' }}
      innerBg="linear-gradient(180deg, color-mix(in srgb, var(--color-surface-2) 75%, transparent), var(--color-bg))"
      gradient="linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 60%, transparent), color-mix(in srgb, var(--color-accent2) 30%, transparent), var(--color-border))"
    >
      <section className="relative overflow-hidden px-6 py-[22px]">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 left-[28%] h-56 w-[29rem]"
          style={{
            background:
              'radial-gradient(closest-side, color-mix(in srgb, var(--color-accent) 14%, transparent), transparent)',
          }}
        />

        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[28px] font-bold leading-tight tracking-[-0.035em] text-[var(--color-text)]">
              {greeting(now.getHours())}. {headline(onTrack, inBox)}
            </h1>
            <p className="mt-1.5 text-[13px] text-[var(--color-text-dim)]">
              {longDate(now)}
              {inBox > 0 && ` · ${inBox === 1 ? 'um agente' : `${inBox} agentes`} esperando a sua decisão`}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* Destaque só com alguém no box: com 0 era o elemento mais vistoso
                do header dizendo que não há nada. */}
            <span
              data-testid="home-in-box"
              data-highlight={inBox > 0 || undefined}
              className={`inline-flex items-center gap-[7px] rounded-full px-3.5 py-1.5 text-xs font-medium ${
                inBox > 0 ? '' : 'border border-[var(--color-border)] text-[var(--color-text-dim)]'
              }`}
              style={
                inBox > 0
                  ? {
                      border: '1px solid color-mix(in srgb, var(--color-accent) 45%, transparent)',
                      background:
                        'linear-gradient(90deg, color-mix(in srgb, var(--color-accent) 20%, transparent), color-mix(in srgb, var(--color-accent2) 10%, transparent))',
                    }
                  : undefined
              }
            >
              <ApexDot size={7} active={inBox > 0} />
              <span className="tabular-nums">{inBox}</span> no box
            </span>
            <span className="inline-flex items-center gap-[7px] rounded-full border border-[var(--color-border)] px-3.5 py-1.5 text-xs font-medium text-[var(--color-text-dim)]">
              <span className="tabular-nums">{onTrack}</span> em pista
            </span>
            <button
              type="button"
              onClick={onRefresh}
              title="Recarregar"
              className="rounded-full border border-[var(--color-border)] p-[7px] text-[var(--color-text-dim)] transition hover:border-[var(--color-text-dim)] hover:text-[var(--color-text)]"
            >
              <Icon as={RefreshCw} size={13} />
            </button>
          </div>
        </div>

        <div className="relative mt-4 flex flex-wrap gap-2">
          <StatChip label="objetivos ativos" value={counts.activeObjectives} />
          <StatChip label="pendências" value={counts.pendingTasks} />
          <StatChip label="vencem hoje" value={counts.dueToday} />
          {counts.overdue > 0 && (
            <StatChip label="atrasada · bandeira" value={counts.overdue} flag />
          )}
        </div>
      </section>
    </GradientBorder>
  )
}

function greeting(hour: number): string {
  if (hour >= 6 && hour < 12) return 'Bom dia'
  if (hour >= 12 && hour < 18) return 'Boa tarde'
  return 'Boa noite'
}

// Headline viva: trabalhando tem precedência; senão quem está no box; senão
// garagem tranquila. Sem inventar número — reflete o snapshot vivo real.
function headline(onTrack: number, inBox: number): string {
  if (onTrack > 0) return `${onTrack} ${onTrack === 1 ? 'agente' : 'agentes'} em pista`
  if (inBox > 0) return `${inBox} no box, sua vez`
  return 'garagem tranquila'
}

function longDate(d: Date): string {
  const text = d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function StatChip({ label, value, flag = false }: { label: string; value: number; flag?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs text-[var(--color-text-dim)]"
      style={{
        background: flag
          ? 'color-mix(in srgb, var(--color-danger) 12%, transparent)'
          : 'color-mix(in srgb, var(--color-bg) 50%, transparent)',
        border: `1px solid ${flag ? 'color-mix(in srgb, var(--color-danger) 50%, transparent)' : 'var(--color-border)'}`,
      }}
    >
      <span
        className="font-bold tabular-nums"
        style={{ color: flag ? 'var(--color-danger)' : 'var(--color-text)' }}
      >
        {value}
      </span>
      {label}
    </span>
  )
}
