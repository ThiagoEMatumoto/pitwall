import { describe, expect, it } from 'vitest'
import { cardDetail, cardFooter, cardTitle, compensatedPx } from './card-display'

describe('cardTitle', () => {
  it('título próprio fica', () => {
    expect(cardTitle({ title: 'caio-f0-estudo', repoLabel: 'legal-app', purpose: 'x' })).toBe(
      'caio-f0-estudo',
    )
  })
  it('título = label do repo: as 6 primeiras palavras do propósito', () => {
    expect(
      cardTitle({
        title: 'legal-app',
        repoLabel: 'legal-app',
        purpose: 'POP-348 · combinar o inicio da pericia com o app',
      }),
    ).toBe('POP-348 · combinar o inicio da…')
    expect(cardTitle({ title: 'legal-app', repoLabel: 'legal-app', purpose: null })).toBe('legal-app')
  })
})

describe('cardFooter', () => {
  const n = { lastSummary: null, lastPrompt: null, purpose: 'p' }
  it('nota > resumo > última mensagem > nada', () => {
    expect(cardFooter({ ...n, lastSummary: 's', lastPrompt: 'l' }, 'nota')).toEqual({
      kind: 'note',
      text: 'nota',
    })
    expect(cardFooter({ ...n, lastSummary: 's', lastPrompt: 'l' }, null)?.kind).toBe('summary')
    expect(cardFooter({ ...n, lastPrompt: 'l' }, null)).toEqual({ kind: 'last', text: 'l' })
    expect(cardFooter(n, null)).toBeNull()
  })
  it('última mensagem igual ao propósito não repete', () => {
    expect(cardFooter({ ...n, lastPrompt: 'p' }, null)).toBeNull()
  })
})

describe('zoom semântico', () => {
  it('faixas e fonte compensada com teto', () => {
    expect(cardDetail(1)).toBe('full')
    expect(cardDetail(0.6)).toBe('brief')
    expect(cardDetail(0.3)).toBe('blocks')
    expect(compensatedPx(0.65)).toBe(20)
    expect(compensatedPx(0.5)).toBe(22)
  })
})
