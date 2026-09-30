import { beforeEach, describe, expect, it } from 'vitest'
import { mruBackTarget, touchMru, useSessionMruStore } from './session-mru-store'

describe('touchMru', () => {
  it('põe a sessão na frente sem duplicar', () => {
    expect(touchMru(['b', 'a'], 'a')).toEqual(['a', 'b'])
    expect(touchMru([], 'a')).toEqual(['a'])
  })

  it('não muta a lista original', () => {
    const order = ['a', 'b']
    touchMru(order, 'b')
    expect(order).toEqual(['a', 'b'])
  })

  it('corta no teto', () => {
    expect(touchMru(['b', 'c', 'd'], 'a', 3)).toEqual(['a', 'b', 'c'])
  })
})

describe('mruBackTarget', () => {
  it('a mais recente que não é a atual e ainda está viva', () => {
    expect(mruBackTarget(['cur', 'dead', 'prev'], 'cur', new Set(['cur', 'prev']))).toBe('prev')
  })

  it('sem sessão ativa (fora de projetos): volta pra última focada', () => {
    expect(mruBackTarget(['a', 'b'], null, new Set(['a', 'b']))).toBe('a')
  })

  it('nada pra onde voltar → null', () => {
    expect(mruBackTarget(['cur'], 'cur', new Set(['cur']))).toBeNull()
    expect(mruBackTarget([], null, new Set())).toBeNull()
  })
})

describe('useSessionMruStore', () => {
  beforeEach(() => useSessionMruStore.setState({ order: [] }))

  it('touch alterna como alt-tab', () => {
    const { touch } = useSessionMruStore.getState()
    touch('a')
    touch('b')
    expect(useSessionMruStore.getState().order).toEqual(['b', 'a'])
    touch('a')
    expect(useSessionMruStore.getState().order).toEqual(['a', 'b'])
  })

  it('touch da sessão que já está na frente não troca o estado', () => {
    useSessionMruStore.getState().touch('a')
    const before = useSessionMruStore.getState().order
    useSessionMruStore.getState().touch('a')
    expect(useSessionMruStore.getState().order).toBe(before)
  })
})
