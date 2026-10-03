import { beforeEach, describe, expect, it } from 'vitest'
import { orderByMru, touchFeatureMru, useFeatureMruStore } from './feature-mru-store'

describe('touchFeatureMru', () => {
  it('põe a feature na frente sem duplicar e sem mutar', () => {
    const order = ['b', 'a']
    expect(touchFeatureMru(order, 'a')).toEqual(['a', 'b'])
    expect(order).toEqual(['b', 'a'])
  })

  it('corta no teto', () => {
    expect(touchFeatureMru(['b', 'c', 'd'], 'a', 3)).toEqual(['a', 'b', 'c'])
  })
})

describe('orderByMru', () => {
  // Confirmou "Sem feature · P" vindo de A: o toque rápido seguinte volta para A.
  it('o grupo "Sem feature" em foco abre a lista; os outros grupos seguem no fim', () => {
    const isTail = (k: string) => k.startsWith('p:')
    expect(orderByMru(['a', 'b', 'p:1', 'p:2'], ['p:1', 'a', 'b'], 'p:1', isTail)).toEqual([
      'p:1',
      'a',
      'b',
      'p:2',
    ])
  })
  it('as usadas primeiro (mais recente antes); as nunca usadas na ordem do grafo', () => {
    expect(orderByMru(['f1', 'f2', 'f3', 'f4'], ['f3', 'f1'], null)).toEqual([
      'f3',
      'f1',
      'f2',
      'f4',
    ])
  })

  it('a feature em foco vem primeiro mesmo sem ter sido tocada', () => {
    expect(orderByMru(['f1', 'f2', 'f3'], ['f3', 'f1'], 'f2')).toEqual(['f2', 'f3', 'f1'])
  })

  it('features removidas do grafo somem', () => {
    expect(orderByMru(['f1'], ['gone', 'f1'], 'gone')).toEqual(['f1'])
  })

  it('os grupos "Sem feature" entram no fim, mesmo se tocados', () => {
    expect(orderByMru(['f1', 'p:x', 'f2'], ['p:x', 'f2'], null, (k) => k.startsWith('p:'))).toEqual(
      ['f2', 'f1', 'p:x'],
    )
  })
})

describe('useFeatureMruStore', () => {
  beforeEach(() => {
    localStorage.clear()
    useFeatureMruStore.setState({ order: [] })
  })

  it('touch alterna as duas últimas como alt-tab', () => {
    const { touch } = useFeatureMruStore.getState()
    touch('a')
    touch('b')
    expect(useFeatureMruStore.getState().order).toEqual(['b', 'a'])
    touch('a')
    expect(useFeatureMruStore.getState().order).toEqual(['a', 'b'])
  })

  it('persiste no localStorage', () => {
    useFeatureMruStore.getState().touch('a')
    useFeatureMruStore.getState().touch('b')
    expect(JSON.parse(localStorage.getItem('cm:feature-mru') ?? 'null')).toEqual(['b', 'a'])
  })
})
