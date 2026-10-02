import { beforeEach, describe, expect, it, vi } from 'vitest'

const { setViewStates } = vi.hoisted(() => ({ setViewStates: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/ipc', () => ({ canvasApi: { setViewStates } }))

import { useCardViewStore } from './card-view-store'

describe('useCardViewStore', () => {
  beforeEach(() => {
    setViewStates.mockClear()
    useCardViewStore.setState({ scope: null, views: {}, tails: {} })
  })

  it('hidrata do banco uma vez por escopo (depois o local é a verdade)', () => {
    const store = useCardViewStore.getState()
    store.hydrate('all', [{ sessionId: 'a', viewState: 'collapsed' }])
    useCardViewStore.getState().toggle('a')
    // Um reload do canvas no meio (outro evento) não desfaz a mudança local.
    useCardViewStore.getState().hydrate('all', [{ sessionId: 'a', viewState: 'collapsed' }])
    expect(useCardViewStore.getState().views.a).toBe('open')
    useCardViewStore.getState().hydrate('p1', [])
    expect(useCardViewStore.getState().views).toEqual({})
  })

  it('grava só a diferença, no escopo aberto', () => {
    useCardViewStore.getState().hydrate('all', [])
    useCardViewStore.getState().collapseAll(['a', 'b'])
    expect(setViewStates).toHaveBeenLastCalledWith({
      scope: 'all',
      items: [
        { sessionId: 'a', viewState: 'collapsed' },
        { sessionId: 'b', viewState: 'collapsed' },
      ],
    })
    setViewStates.mockClear()
    useCardViewStore.getState().collapseAll(['a', 'b'])
    expect(setViewStates).not.toHaveBeenCalled()
  })

  it('grava a correção da hidratação (terminal legado no cartão → aberto)', () => {
    useCardViewStore.getState().hydrate('all', [
      { sessionId: 'a', viewState: 'terminal' },
      { sessionId: 'b', viewState: 'collapsed' },
    ])
    expect(setViewStates).toHaveBeenCalledWith({
      scope: 'all',
      items: [{ sessionId: 'a', viewState: 'open' }],
    })
  })

  it('antes de hidratar não grava (escopo desconhecido)', () => {
    useCardViewStore.getState().toggle('a')
    expect(setViewStates).not.toHaveBeenCalled()
  })

  it('pedido de terminal de sessão nova expira se o cartão nunca aparecer', () => {
    vi.useFakeTimers()
    try {
      useCardViewStore.getState().requestTerminal('nova')
      expect(useCardViewStore.getState().pendingTerminal).toBe('nova')
      vi.advanceTimersByTime(20_000)
      expect(useCardViewStore.getState().pendingTerminal).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pedido mais novo não é apagado pelo timer do anterior', () => {
    vi.useFakeTimers()
    try {
      useCardViewStore.getState().requestTerminal('a')
      vi.advanceTimersByTime(10_000)
      useCardViewStore.getState().requestTerminal('b')
      vi.advanceTimersByTime(10_000)
      expect(useCardViewStore.getState().pendingTerminal).toBe('b')
    } finally {
      vi.useRealTimers()
    }
  })
})
