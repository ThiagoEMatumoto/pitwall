import { claudeProvider } from './claude'
import type { AgentProvider, AgentProviderId } from './types'

const PROVIDERS: Partial<Record<AgentProviderId, AgentProvider>> = {
  claude: claudeProvider,
}

// Sem id (linha pré-050, chamador legado) = claude. Id conhecido sem provider
// registrado lança: cair no claude em silêncio rodaria a CLI errada.
export function getProvider(id: AgentProviderId | null | undefined = 'claude'): AgentProvider {
  const provider = PROVIDERS[id ?? 'claude']
  if (!provider) throw new Error(`Provider de agente não suportado: ${id}`)
  return provider
}
