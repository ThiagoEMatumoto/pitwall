import { describe, expect, it } from 'vitest'
import { RECENT_CONVERSATION_MS, hasDockConversations } from './dock-visibility'
import type { AgentBusSnapshot, AgentMessageView } from '../../../shared/types/agent-bus'

const NOW = 10_000_000
const ZERO: AgentBusSnapshot['counters'] = {
  asked: 0,
  delivered: 0,
  answered: 0,
  expired: 0,
  rejectedDepth: 0,
  rejectedRate: 0,
  rejectedSelf: 0,
  undeliverable: 0,
  needsHandoff: 0,
}

const msg = (over: Partial<AgentMessageView>): AgentMessageView =>
  ({ status: 'answered', createdAt: NOW, answeredAt: null, ...over }) as AgentMessageView

const snap = (
  messages: AgentMessageView[],
  counters: Partial<AgentBusSnapshot['counters']> = {},
): AgentBusSnapshot => ({ messages, counters: { ...ZERO, ...counters } })

describe('hasDockConversations', () => {
  it('banco vazio, sem guardas acionadas: nada a mostrar', () => {
    expect(hasDockConversations(snap([]), NOW)).toBe(false)
  })

  // Snapshot é o LIMIT 50 de sempre: uma conversa de dias atrás não pode prender o dock.
  it('só conversas antigas e encerradas: dock some', () => {
    const old = NOW - RECENT_CONVERSATION_MS - 1
    const messages = [
      msg({ status: 'answered', createdAt: old - 1000, answeredAt: old }),
      msg({ status: 'expired', createdAt: old }),
    ]
    expect(hasDockConversations(snap(messages, { asked: 2, answered: 1, expired: 1 }), NOW)).toBe(
      false,
    )
  })

  it('pergunta pendente segura o dock, por mais velha que seja', () => {
    expect(hasDockConversations(snap([msg({ status: 'pending', createdAt: 0 })]), NOW)).toBe(true)
  })

  it('conversa respondida há pouco ainda aparece', () => {
    const recent = msg({ createdAt: NOW - 60_000, answeredAt: NOW - 1000 })
    expect(hasDockConversations(snap([recent]), NOW)).toBe(true)
  })

  // Ask barrado não cria linha: sem isto o contador nunca seria visto.
  it.each([
    'rejectedDepth',
    'rejectedRate',
    'rejectedSelf',
    'undeliverable',
    'needsHandoff',
  ] as const)('guarda %s acionada sem nenhuma linha: dock aparece', (counter) => {
    expect(hasDockConversations(snap([], { [counter]: 1 }), NOW)).toBe(true)
  })
})
