import { claudeProvider } from './claude'
import { codexProvider } from './codex'
import type { AgentProvider, AgentProviderId } from './types'

const PROVIDERS: Partial<Record<AgentProviderId, AgentProvider>> = {
  claude: claudeProvider,
  codex: codexProvider,
}

// Sem id (linha pré-050, chamador legado) = claude. Id conhecido sem provider
// registrado lança: cair no claude em silêncio rodaria a CLI errada.
export function getProvider(id: AgentProviderId | null | undefined = 'claude'): AgentProvider {
  const provider = PROVIDERS[id ?? 'claude']
  if (!provider) throw new Error(`Provider de agente não suportado: ${id}`)
  return provider
}

export function registeredProviderIds(): AgentProviderId[] {
  return Object.keys(PROVIDERS) as AgentProviderId[]
}

// Não lança (ao contrário de getProvider): roda dentro do evento de spawn da PTY,
// onde um throw sairia pelo ptyManager.spawn depois do processo já ter nascido.
export function providerSupportsTuiMenus(id: AgentProviderId | null | undefined): boolean {
  return PROVIDERS[id ?? 'claude']?.supports.tuiMenus ?? false
}
