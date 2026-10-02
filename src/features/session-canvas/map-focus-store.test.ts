import { beforeEach, describe, expect, it } from 'vitest'
import { useMapFocusStore } from './map-focus-store'
import { useFeatureMruStore } from './feature-mru-store'

describe('useMapFocusStore', () => {
  beforeEach(() => useMapFocusStore.setState({ featureId: null, frame: null }))

  it('a feature usada por último fica como a em foco', () => {
    useMapFocusStore.getState().setFeature('f1')
    useMapFocusStore.getState().setFeature('f2')
    expect(useMapFocusStore.getState().featureId).toBe('f2')
  })

  // Regressão: depois de um grupo "Sem feature", clicar no cartão da feature que
  // já estava em foco não subia no MRU, e o toque rápido ficava nela.
  it('setFeature da feature já em foco ainda sobe no MRU', () => {
    useMapFocusStore.setState({ featureId: 'f1' })
    useFeatureMruStore.setState({ order: ['p:proj', 'f1'] })
    useMapFocusStore.getState().setFeature('f1')
    expect(useFeatureMruStore.getState().order).toEqual(['f1', 'p:proj'])
    useMapFocusStore.getState().focusFeature('f2')
    expect(useFeatureMruStore.getState().order[0]).toBe('f2')
  })

  it('focusFeature define a feature e deixa um pedido de enquadrar, de uso único', () => {
    useMapFocusStore.getState().focusFeature('f3')
    expect(useMapFocusStore.getState().featureId).toBe('f3')
    expect(useMapFocusStore.getState().takeFrame()).toEqual({
      flowId: 'lane:f:f3',
      featureId: 'f3',
    })
    expect(useMapFocusStore.getState().takeFrame()).toBeNull()
  })

  it('cada pedido novo da mesma feature muda o nonce (o mapa reenquadra de novo)', () => {
    useMapFocusStore.getState().focusFeature('f1')
    const a = useMapFocusStore.getState().frame?.nonce
    useMapFocusStore.getState().focusFeature('f1')
    expect(useMapFocusStore.getState().frame?.nonce).not.toBe(a)
  })

  it('frameLane só enquadra: a feature em foco (e a mãe do painel) não muda', () => {
    useMapFocusStore.getState().setFeature('f1')
    useMapFocusStore.getState().frameLane('lane:p:p1')
    expect(useMapFocusStore.getState().featureId).toBe('f1')
    expect(useMapFocusStore.getState().takeFrame()).toEqual({
      flowId: 'lane:p:p1',
      featureId: null,
    })
  })
})
