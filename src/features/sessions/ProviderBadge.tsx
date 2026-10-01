import { PROVIDER_BADGES, PROVIDER_LABELS, isNonClaude } from '../../../shared/agent-providers'
import type { AgentProviderId } from '../../../shared/types/ipc'

interface Props {
  provider: AgentProviderId | null | undefined
  className?: string
}

// Só marca quem NÃO é o claude: o default não precisa de etiqueta, e um badge
// em toda aba viraria ruído. Ausente = claude (linha pré-050).
export function ProviderBadge({ provider, className = '' }: Props) {
  if (!provider || !isNonClaude(provider)) return null
  return (
    <span
      data-testid="provider-badge"
      data-provider={provider}
      title={PROVIDER_LABELS[provider]}
      className={`shrink-0 rounded border border-[var(--color-info)]/50 px-1 text-[9px] font-medium uppercase leading-[14px] tracking-wide text-[var(--color-info)] ${className}`}
    >
      {PROVIDER_BADGES[provider]}
    </span>
  )
}
