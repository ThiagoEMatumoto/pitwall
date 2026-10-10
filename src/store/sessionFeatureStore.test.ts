import { beforeEach, describe, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({
  handler: null as null | ((e: { sessionId: string; featureId: string | null }) => void),
}))

vi.mock('@/lib/ipc', () => ({
  featuresApi: {
    get: vi.fn().mockResolvedValue({ id: 'f-painel', title: 'Painel' }),
    listWithStats: vi.fn().mockResolvedValue([{ id: 'f-lazy', title: 'Lazy', sessionCount: 2 }]),
  },
  sessionsApi: {
    // Como o main: linhas de sessions da feature, a mais recente primeiro.
    listByFeature: vi.fn().mockResolvedValue([
      { id: 's-new', ccSessionId: 'cc-1' },
      { id: 's-old', ccSessionId: 'cc-1' },
      { id: 's-nocc', ccSessionId: null },
    ]),
    onFeatureChanged: (h: typeof seam.handler) => {
      seam.handler = h
      return () => {
        seam.handler = null
      }
    },
  },
}))

import {
  featureIdForCc,
  listenSessionFeatureChanges,
  useSessionFeatureStore,
} from './sessionFeatureStore'

beforeEach(() => {
  useSessionFeatureStore.setState({ bySessionId: { s4: 'f-checkout' }, featureTitles: {} })
})

describe('listenSessionFeatureChanges', () => {
  it('a resolução contínua do main move a sessão no índice do renderer', () => {
    const stop = listenSessionFeatureChanges()
    seam.handler?.({ sessionId: 's4', featureId: 'f-painel' })
    expect(useSessionFeatureStore.getState().bySessionId.s4).toBe('f-painel')

    seam.handler?.({ sessionId: 's4', featureId: null })
    expect(useSessionFeatureStore.getState().bySessionId.s4).toBeUndefined()
    stop()
    expect(seam.handler).toBeNull()
  })
})

describe('featureIdForCc (pane dormindo só tem o cc)', () => {
  it('o hydrate indexa as linhas por cc e a feature sai do mesmo bySessionId', async () => {
    useSessionFeatureStore.setState({ bySessionId: {}, sessionIdsByCc: {}, hydrated: false })
    await useSessionFeatureStore.getState().hydrate()

    const state = useSessionFeatureStore.getState()
    expect(state.sessionIdsByCc).toEqual({ 'cc-1': ['s-new', 's-old'] })
    expect(featureIdForCc(state, 'cc-1')).toBe('f-lazy')
    expect(featureIdForCc(state, 'cc-x')).toBeNull()

    // Desvinculada pelo broadcast do main: o cc deixa de resolver.
    state.forget('s-new')
    state.forget('s-old')
    expect(featureIdForCc(useSessionFeatureStore.getState(), 'cc-1')).toBeNull()
  })
})
