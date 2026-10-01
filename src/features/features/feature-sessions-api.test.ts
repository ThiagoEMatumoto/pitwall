import { describe, expect, it } from 'vitest'
import type { FeatureSessionSummary } from '../../../shared/types/ipc'
import { orderWithMothers } from './feature-sessions-api'

const s = (id: string, startedAt: number, motherSessionId: string | null = null): FeatureSessionSummary => ({
  id,
  ccSessionId: `cc-${id}`,
  repoId: null,
  title: id,
  titleSource: null,
  status: 'running',
  startedAt,
  endedAt: null,
  isLive: true,
  motherSessionId,
})

describe('orderWithMothers', () => {
  it('mãe acima das filhas; filha de mãe fora da feature fica no topo', () => {
    const out = orderWithMothers([s('c1', 30, 'm'), s('m', 10), s('solta', 20), s('orfa', 40, 'x'), s('c2', 25, 'm')])
    expect(out.map((e) => [e.session.id, e.depth])).toEqual([
      ['orfa', 0],
      ['solta', 0],
      ['m', 0],
      ['c1', 1],
      ['c2', 1],
    ])
    expect(out.find((e) => e.session.id === 'm')?.childCount).toBe(2)
    expect(out.find((e) => e.session.id === 'c1')?.motherTitle).toBe('m')
  })

  it('neta (A→B→C) aparece sob a filha, nada some', () => {
    const out = orderWithMothers([s('A', 10), s('B', 20, 'A'), s('C', 30, 'B')])
    expect(out.map((e) => [e.session.id, e.depth, e.motherTitle])).toEqual([
      ['A', 0, null],
      ['B', 1, 'A'],
      ['C', 1, 'B'],
    ])
  })

  it('ciclo de mother_session_id não esconde as sessões', () => {
    const out = orderWithMothers([s('X', 10, 'Y'), s('Y', 20, 'X')])
    expect(out.map((e) => e.session.id).sort()).toEqual(['X', 'Y'])
  })
})
