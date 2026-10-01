import { beforeEach, describe, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({
  handler: null as null | ((e: { sessionId: string; featureId: string | null }) => void),
}))

vi.mock('@/lib/ipc', () => ({
  featuresApi: { get: vi.fn().mockResolvedValue({ id: 'f-painel', title: 'Painel' }) },
  sessionsApi: {
    onFeatureChanged: (h: typeof seam.handler) => {
      seam.handler = h
      return () => {
        seam.handler = null
      }
    },
  },
}))

import { listenSessionFeatureChanges, useSessionFeatureStore } from './sessionFeatureStore'

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
