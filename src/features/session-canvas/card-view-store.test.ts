import { beforeEach, describe, expect, it, vi } from 'vitest'

const { setViewStates } = vi.hoisted(() => ({ setViewStates: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/ipc', () => ({ canvasApi: { setViewStates } }))

import { useCardViewStore } from './card-view-store'

describe('useCardViewStore', () => {
  beforeEach(() => {
    setViewStates.mockClear()
    useCardViewStore.setState({ scope: null, views: {}, terminalSizes: {}, tails: {} })
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
    useCardViewStore.getState().enterTerminal('a')
    useCardViewStore.getState().enterTerminal('b')
    expect(setViewStates).toHaveBeenLastCalledWith({
      scope: 'all',
      items: [
        { sessionId: 'a', viewState: 'open' },
        { sessionId: 'b', viewState: 'terminal' },
      ],
    })
    setViewStates.mockClear()
    useCardViewStore.getState().openAll(['a', 'b'])
    expect(setViewStates).not.toHaveBeenCalled()
  })

  it('grava a correção da hidratação (dois terminais salvos → um)', () => {
    useCardViewStore.getState().hydrate('all', [
      { sessionId: 'a', viewState: 'terminal' },
      { sessionId: 'b', viewState: 'terminal' },
    ])
    expect(setViewStates).toHaveBeenCalledWith({
      scope: 'all',
      items: [{ sessionId: 'b', viewState: 'open' }],
    })
  })

  it('antes de hidratar não grava (escopo desconhecido)', () => {
    useCardViewStore.getState().toggle('a')
    expect(setViewStates).not.toHaveBeenCalled()
  })
})
