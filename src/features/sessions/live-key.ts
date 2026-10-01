import { providerSupports } from '../../../shared/agent-providers'
import type { AgentProviderId } from '../../../shared/types/ipc'

// Chave que casa pane, nó do grafo e LiveSessionInfo.ccSessionId: o id nativo do
// agente; provider sem resume (Codex) não tem id nativo e o main usa o sessions.id
// (livePtySessionInfo). Sem esta regra o Codex some do chip, do Alt+,/. e do MRU.
export function liveKeyOf(
  sessionsId: string,
  ccSessionId: string | null,
  provider: AgentProviderId | null | undefined,
): string | null {
  if (ccSessionId) return ccSessionId
  return providerSupports(provider).resume ? null : sessionsId
}

export const graphNodeLiveKey = (n: {
  sessionId: string
  ccSessionId: string | null
  provider?: AgentProviderId | null
}): string | null => liveKeyOf(n.sessionId, n.ccSessionId, n.provider)
