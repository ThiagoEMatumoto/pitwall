import type { AgentProviderId } from './ipc'
import type { SessionGraphStatus } from './session-graph'

// Agente perguntando a agente (P7): uma sessão viva pergunta a outra — inclusive
// de outro projeto — e a resposta volta estruturada. Livre (sem aprovação
// humana), mas com guardas: profundidade de cadeia, rate limit por par, TTL.

export type AgentAskStatus = 'pending' | 'answered' | 'expired'

// Como o ask saiu: entregue (ou na fila on-idle) pela PTY de uma sessão viva, ou
// sem ninguém naquele repo — aí a sugestão é um session_handoff.
export type AgentAskMode = 'delivered' | 'queued' | 'needs-handoff'

export interface AgentPeer {
  sessionId: string
  // Rótulo da sessão (o nome da aba: rename manual > `-n` do CLI > título).
  alias: string
  // O `-n` do CLI vivo — o endereço do SendMessage. null fora do claude ou sem nome.
  address: string | null
  projectId: string | null
  projectName: string | null
  repoId: string | null
  repoLabel: string | null
  provider: AgentProviderId
  status: SessionGraphStatus
  purpose: string | null
  lastActivityAt: number | null
  startedAt: number | null
}

export interface AgentMessage {
  id: string
  fromSessionId: string
  toSessionId: string | null
  toRepoId: string | null
  featureId: string | null
  depth: number
  text: string
  reply: string | null
  status: AgentAskStatus
  createdAt: number
  deliveredAt: number | null
  answeredAt: number | null
  expiresAt: number
}

// Linha da aba Conversas: a mensagem + quem é quem, já resolvido no main.
export interface AgentMessageView extends AgentMessage {
  fromLabel: string
  toLabel: string
}

// Contadores consumíveis: cada supressão/expiração tem número, não só log.
export interface AgentBusCounters {
  asked: number
  delivered: number
  answered: number
  expired: number
  rejectedDepth: number
  rejectedRate: number
  rejectedSelf: number
  undeliverable: number
  needsHandoff: number
  // Lazy restore: o destino dormia e foi acordado / não acordou.
  wokeDormant: number
  wakeFailed: number
}

export interface AgentBusSnapshot {
  messages: AgentMessageView[]
  counters: AgentBusCounters
}
