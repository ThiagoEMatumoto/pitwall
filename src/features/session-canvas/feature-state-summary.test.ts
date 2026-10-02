import { describe, expect, it } from 'vitest'
import { clipAtWord, featureCrew, featureReminders, sessionStatusCounts } from './feature-state-summary'

describe('sessionStatusCounts', () => {
  it('conta só as sessões vivas da feature, por estado', () => {
    const nodes = [
      { featureId: 'f', status: 'working', attentionReason: null },
      { featureId: 'f', status: 'starting', attentionReason: null },
      { featureId: 'f', status: 'idle', attentionReason: 'handoff-input' },
      { featureId: 'f', status: 'waiting', attentionReason: null },
      { featureId: 'f', status: 'idle', attentionReason: null },
      { featureId: 'f', status: 'ended', attentionReason: null },
      { featureId: 'g', status: 'working', attentionReason: null },
    ] as const
    expect(sessionStatusCounts([...nodes], 'f')).toEqual({ needsYou: 2, working: 2, idle: 1 })
  })
})

describe('featureReminders', () => {
  it('notas fixadas antes das regras; cada item de lista é uma regra', () => {
    const body = `## Regras de negócio\n\n- Desconto máx 10%\n- Valores em centavos\n\n## Notas fixadas\n\nEstorno só\npela API nova\n\n---\n\nSegunda\n`
    expect(featureReminders(body)).toEqual([
      'Estorno só pela API nova',
      'Segunda',
      'Desconto máx 10%',
      'Valores em centavos',
    ])
  })
  it('sem seções: nada', () => {
    expect(featureReminders('## Visão geral\n\nx')).toEqual([])
  })
})

describe('clipAtWord', () => {
  it('corta no fim da palavra, sem pontuação pendurada', () => {
    expect(clipAtWord('Estorno só pela API nova de pagamentos: a antiga duplica', 40)).toBe(
      'Estorno só pela API nova de pagamentos…',
    )
    expect(clipAtWord('curto', 40)).toBe('curto')
  })
  it('palavra única gigante: corta no limite', () => {
    expect(clipAtWord('a'.repeat(50), 10)).toBe(`${'a'.repeat(10)}…`)
  })
})

describe('featureCrew', () => {
  const n = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    featureId: 'f',
    status: 'working' as const,
    attentionReason: null,
    isMother: false,
    childCount: 0,
    childOfHandoffId: null as string | null,
    ...over,
  })
  it('mãe primeiro, depois as filhas, depois as demais vivas da feature', () => {
    const nodes = [
      n('solta-f'),
      n('otavio', { childOfHandoffId: 'h1', status: 'waiting' }),
      n('mae', { isMother: true, childCount: 2 }),
      n('marina', { childOfHandoffId: 'h2', status: 'idle' }),
      n('fim', { status: 'ended' }),
      n('outra', { featureId: 'g' }),
    ]
    const c = featureCrew(nodes, 'f')
    expect(c.mother?.id).toBe('mae')
    expect(c.childCount).toBe(2)
    expect(c.rows.map((r) => [r.node.id, r.state, r.isChild])).toEqual([
      ['mae', 'working', false],
      ['otavio', 'needsYou', true],
      ['marina', 'idle', true],
      ['solta-f', 'working', false],
    ])
  })
  it('sem mãe: ninguém é filha, a lista fica na ordem do grafo', () => {
    const c = featureCrew([n('a'), n('b', { childOfHandoffId: 'h' })], 'f')
    expect(c.mother).toBeNull()
    expect(c.rows.map((r) => r.isChild)).toEqual([false, false])
  })
})
