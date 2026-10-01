import type { AgentBusCounters, AgentBusSnapshot } from '../../../shared/types/agent-bus'

// O que segura o Crew Dock aberto do lado das Conversas. O snapshot é o LIMIT 50
// de sempre (sem purge), então "tem linha" não serve: o dock nunca mais sumiria.
// Vale o que ainda pede olho — pergunta pendente, conversa recente — e as guardas
// que barraram um ask (esse não grava linha, e o contador é a única pista).

export const RECENT_CONVERSATION_MS = 30 * 60_000

const GUARD_COUNTERS: ReadonlyArray<keyof AgentBusCounters> = [
  'rejectedDepth',
  'rejectedRate',
  'rejectedSelf',
  'undeliverable',
  'needsHandoff',
]

export function hasDockConversations(snapshot: AgentBusSnapshot, now: number): boolean {
  const live = snapshot.messages.some(
    (m) => m.status === 'pending' || now - (m.answeredAt ?? m.createdAt) < RECENT_CONVERSATION_MS,
  )
  return live || GUARD_COUNTERS.some((k) => snapshot.counters[k] > 0)
}
