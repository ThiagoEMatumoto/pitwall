// Capacidades por CLI de agente. Fonte única para o main (providers/*.ts) e o
// renderer (gates de Chat View, pills e parser de menu): os dois lados lerem a
// mesma tabela é o que impede o renderer de oferecer o que o provider não tem.
import type { AgentProviderId } from './types/ipc'

export interface ProviderSupports {
  // Retomar por id nativo (claude --resume). Sem isso: sem resume nem adoção.
  resume: boolean
  // Transcript no disco que o app sabe ler (JSONL do claude).
  nativeTranscript: boolean
  // TUI cujos menus/prompt o app parseia (tui-menu-watch, PermissionPill, fila).
  tuiMenus: boolean
  // Modo de permissão escolhido no spawn.
  permissionModes: boolean
  chatView: boolean
}

export const PROVIDER_SUPPORTS: Record<AgentProviderId, ProviderSupports> = {
  claude: {
    resume: true,
    nativeTranscript: true,
    tuiMenus: true,
    permissionModes: true,
    chatView: true,
  },
  codex: {
    resume: false,
    nativeTranscript: false,
    tuiMenus: false,
    permissionModes: true,
    chatView: false,
  },
}

export const PROVIDER_LABELS: Record<AgentProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex (experimental)',
}

// Rótulo curto do badge (aba, strip, cartão do mapa).
export const PROVIDER_BADGES: Record<AgentProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

export const CLAUDE_ONLY_REASON = 'Disponível só para Claude Code por enquanto'

// Sem provider (linha pré-050, fixture do renderer) = claude.
export function providerSupports(id: AgentProviderId | null | undefined): ProviderSupports {
  return PROVIDER_SUPPORTS[id ?? 'claude'] ?? PROVIDER_SUPPORTS.claude
}

export function isNonClaude(id: AgentProviderId | null | undefined): boolean {
  return (id ?? 'claude') !== 'claude'
}
