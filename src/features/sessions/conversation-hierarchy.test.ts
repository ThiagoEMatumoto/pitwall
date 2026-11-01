import { describe, expect, it } from 'vitest'
import {
  groupStatusUnderMother,
  isMotherLike,
  motherOfChildMap,
  nestUnderMothers,
  pinnedMothersFirst,
} from './conversation-hierarchy'

const ids = (xs: Array<{ item: { id: string }; depth: number }>) =>
  xs.map((x) => `${'>'.repeat(x.depth)}${x.item.id}`)

describe('conversation-hierarchy', () => {
  it('motherOfChildMap ignora auto-referência e quem não é filha', () => {
    const m = motherOfChildMap([
      { sessionId: 'a', hierarchyMotherId: null },
      { sessionId: 'b', hierarchyMotherId: 'a' },
      { sessionId: 'c', hierarchyMotherId: 'c' },
    ])
    expect([...m]).toEqual([['b', 'a']])
  })

  it('nest: filha e neta logo abaixo da mãe, mesmo vindo antes dela na lista', () => {
    const items = ['neta', 'x', 'filha', 'mae', 'y'].map((id) => ({ id }))
    const m = new Map([
      ['filha', 'mae'],
      ['neta', 'filha'],
    ])
    expect(ids(nestUnderMothers(items, m))).toEqual(['x', 'mae', '>filha', '>>neta', 'y'])
  })

  it('nest: filha com mãe fora da lista fica como raiz; ciclo não some', () => {
    const items = [{ id: 'orfa' }, { id: 'a' }, { id: 'b' }]
    const m = new Map([
      ['orfa', 'longe'],
      ['a', 'b'],
      ['b', 'a'],
    ])
    const out = nestUnderMothers(items, m)
    expect(out.map((x) => x.item.id).sort()).toEqual(['a', 'b', 'orfa'])
    expect(out.find((x) => x.item.id === 'orfa')?.depth).toBe(0)
  })

  it('pinnedMothersFirst: sobe a subárvore da mãe fixada na ordem do pin', () => {
    const nested = nestUnderMothers(
      ['p', 'q', 'q-kid', 'r'].map((id) => ({ id })),
      new Map([['q-kid', 'q']]),
    )
    const { pinned, rest } = pinnedMothersFirst(nested, ['r', 'q'])
    expect(ids(pinned)).toEqual(['r', 'q', '>q-kid'])
    expect(ids(rest)).toEqual(['p'])
  })

  it('isMotherLike: lidera filhas OU marcada', () => {
    expect(isMotherLike({ isMother: false, isPinnedMother: true })).toBe(true)
    expect(isMotherLike({ isMother: true })).toBe(true)
    expect(isMotherLike({})).toBe(false)
  })

  it('groupStatusUnderMother: filha e neta herdam o status da raiz presente', () => {
    const items = [
      { id: 'mae', status: 'idle' },
      { id: 'filha', status: 'waiting' },
      { id: 'neta', status: 'working' },
      { id: 'orfa', status: 'working' },
    ]
    const m = new Map([
      ['filha', 'mae'],
      ['neta', 'filha'],
      ['orfa', 'longe'],
    ])
    expect(Object.fromEntries(groupStatusUnderMother(items, m))).toEqual({
      mae: 'idle',
      filha: 'idle',
      neta: 'idle',
      orfa: 'working',
    })
  })
})
