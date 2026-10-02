import { describe, expect, it } from 'vitest'
import { peekRole, peekRoleLabel, stripOrder } from './peek-identity'

describe('peekRole', () => {
  it('mãe com a contagem de filhas, filha pelo handoff, avulsa sem selo', () => {
    expect(peekRole({ isMother: true, childCount: 2, childOfHandoffId: null })).toEqual({
      kind: 'mother',
      children: 2,
    })
    expect(peekRole({ isMother: false, childOfHandoffId: 'h1' })).toEqual({ kind: 'child' })
    expect(peekRole({ childOfHandoffId: null })).toBeNull()
    expect(peekRole(undefined)).toBeNull()
  })
  it('selo no texto do cartão', () => {
    expect(peekRoleLabel({ kind: 'mother', children: 2 })).toBe('MÃE · 2')
    expect(peekRoleLabel({ kind: 'child' })).toBe('FILHA')
    expect(peekRoleLabel(null)).toBeNull()
  })
})

describe('stripOrder', () => {
  it('mãe primeiro, depois filhas, depois o resto, mantendo a ordem dentro de cada grupo', () => {
    const roles: Record<string, ReturnType<typeof peekRole>> = {
      c1: { kind: 'child' },
      m: { kind: 'mother', children: 2 },
      c2: { kind: 'child' },
    }
    expect(stripOrder(['c1', 'x', 'm', 'c2', 'y'], (id) => roles[id] ?? null)).toEqual([
      'm',
      'c1',
      'c2',
      'x',
      'y',
    ])
  })
})
