import { describe, expect, it } from 'vitest'
import { clipAtWord, featureReminders, sessionStatusCounts } from './feature-state-summary'

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
