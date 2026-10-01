import { describe, expect, it } from 'vitest'
import { counterLines } from './queue-counters'
import type { PromptQueueSnapshot } from '../../../shared/types/send-prompt'

const snap = (counters: Partial<PromptQueueSnapshot['counters']>, items = 0) =>
  ({
    items: Array.from({ length: items }, () => ({})),
    counters: {
      delivered: 0,
      expired: 0,
      sessionGone: 0,
      refusedMenuOpen: 0,
      refusedUnparsed: 0,
      refusedInputDirty: 0,
      ...counters,
    },
  }) as unknown as PromptQueueSnapshot

describe('counterLines', () => {
  it('só os contadores maiores que zero, em linguagem de quem usa', () => {
    expect(counterLines(snap({ refusedMenuOpen: 2 }))).toEqual([
      '2 mensagens seguradas: menu aberto na sessão',
    ])
    expect(counterLines(snap({ delivered: 1, expired: 1, sessionGone: 1 }, 1))).toEqual([
      '1 mensagem na fila',
      '1 mensagem entregue',
      '2 mensagens expiraram',
    ])
  })
  it('tudo zerado: nenhuma linha', () => {
    expect(counterLines(snap({}))).toEqual([])
  })
})
