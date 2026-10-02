import { Loader2 } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { formatRelative, shortenAgentName, statusDotView } from './status-view'
import type { SessionActivity, SubagentActivity } from '../../../shared/types/ipc'

// HUD fino estilo statusline (Warp) entre o terminal e o composer: status da
// sessão sempre legível fora da TUI + chips dos subagentes do turno corrente.
// Estética CALMA, coerente com o hero de 1 linha: sem bordas por chip, só texto
// dim com glyph colorido; detalhe (description) vive no tooltip.

// Espelha o cap da derivação no main (MAX_SUBAGENTS); se o payload vier maior,
// mostra os primeiros e resume o resto em "+N".
const MAX_CHIPS = 4

interface Props {
  activity: SessionActivity | null
  now: number
  // Status vindo de quem monta (a modal do mapa passa o MESMO selo do header):
  // sem isto o HUD lia o watch por sessão e mostrava "Iniciando" enquanto o
  // chip do header já dizia "trabalhando".
  status?: { label: string; color: string }
}

function SubagentChip({ agent }: { agent: SubagentActivity }) {
  const name = shortenAgentName(agent.name)
  return (
    <span
      title={agent.description || agent.name}
      className="flex min-w-0 shrink items-center gap-1"
    >
      <span className="truncate">{name}</span>
      {agent.state === 'running' && (
        <Icon as={Loader2} size={10} className="shrink-0 animate-spin text-[var(--color-accent)]" />
      )}
      {agent.state === 'ok' && <span className="shrink-0 text-[var(--color-success)]">✓</span>}
      {agent.state === 'error' && <span className="shrink-0 text-[var(--color-danger)]">✕</span>}
    </span>
  )
}

export function AgentHud({ activity, now, status }: Props) {
  // Primeiro broadcast ainda em voo (activity null) → mostra como iniciando.
  const fromActivity = statusDotView(activity?.status ?? 'starting')
  const dot = status ? { label: status.label, className: '', pulse: false } : fromActivity
  const relTime = activity?.lastActivityAt ? formatRelative(now - activity.lastActivityAt) : null
  const subagents = activity?.subagents ?? []
  const shown = subagents.slice(0, MAX_CHIPS)
  const overflow = subagents.length - shown.length

  return (
    <div
      role="status"
      aria-label={[dot.label, relTime].filter(Boolean).join(' ')}
      className="flex h-6 shrink-0 items-center gap-2 overflow-hidden border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[11px] text-[var(--color-text-dim)]"
    >
      <span
        data-testid="agent-hud-status"
        className={`flex shrink-0 items-center gap-1.5 ${dot.className}`}
        style={status ? { color: status.color } : undefined}
      >
        {dot.pulse && <Icon as={Loader2} size={11} className="animate-spin" />}
        {dot.label}
      </span>
      {relTime && <span className="shrink-0">{relTime}</span>}
      {shown.length > 0 && (
        <>
          <span className="shrink-0 text-[var(--color-border)]">·</span>
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
            {shown.map((agent, i) => (
              <SubagentChip key={`${agent.name}-${i}`} agent={agent} />
            ))}
            {overflow > 0 && <span className="shrink-0">+{overflow}</span>}
          </div>
        </>
      )}
    </div>
  )
}
