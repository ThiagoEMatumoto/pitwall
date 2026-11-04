import { describe, expect, it, vi } from 'vitest'
import type { ChatFallbackCounters } from '../../../shared/chat/fallback'
import { chatFallbackCounters, noteChatFallback } from './chat-fallback-counter'

function memoryStore() {
  let value: ChatFallbackCounters = { chatFallbacks: {}, lastChatFallbackAt: null }
  return { get: () => value, set: (v: ChatFallbackCounters) => (value = v) }
}

describe('noteChatFallback', () => {
  it('conta por kind:motivo, acumula e grava no store', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = memoryStore()
    noteChatFallback('plan', 'no-options', store, 10)
    noteChatFallback('plan', 'no-options', store, 20)
    noteChatFallback('unknown', 'wait-in-terminal', store, 30)
    expect(chatFallbackCounters(store)).toEqual({
      chatFallbacks: { 'plan:no-options': 2, 'unknown:wait-in-terminal': 1 },
      lastChatFallbackAt: 30,
    })
  })
})
