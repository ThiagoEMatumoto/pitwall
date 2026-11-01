import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('./db', () => ({ getDb: () => ({}) }))

import { currentModel, deriveEnrichment } from './session-activity'

// Forma real (2.1.316) da última resposta de uma filha antes do "Tornar mãe": o
// relance subiu com --model haiku, mas até a 1ª resposta nova o transcript só tem
// Sonnet, e o chip mostrava Sonnet com o processo rodando Haiku.
const SONNET_TAIL = [
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-11-01T18:27:10.119Z',
    isSidechain: false,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: 'ok' }],
    },
  }),
  JSON.stringify({ type: 'system', timestamp: '2026-11-01T18:27:10.180Z' }),
].join('\n')

describe('modelo da sessão no chip', () => {
  it('deriveEnrichment devolve quando a última resposta foi escrita', () => {
    const e = deriveEnrichment(SONNET_TAIL)
    expect(e.model).toBe('claude-sonnet-5-5')
    expect(e.modelAt).toBe(Date.parse('2026-11-01T18:27:10.119Z'))
  })

  it('processo relançado com --model e sem resposta nova: vale o --model', () => {
    const e = deriveEnrichment(SONNET_TAIL)
    const startedAt = Date.parse('2026-11-01T18:28:00.000Z')
    expect(currentModel(e, { model: 'haiku', startedAt })).toBe('haiku')
  })

  it('resposta depois do início do processo: vale o transcript (inclui /model)', () => {
    const e = deriveEnrichment(SONNET_TAIL)
    const startedAt = Date.parse('2026-11-01T18:20:00.000Z')
    expect(currentModel(e, { model: 'haiku', startedAt })).toBe('claude-sonnet-5-5')
  })

  it('spawn sem --model ou sem início conhecido: vale o transcript', () => {
    const e = deriveEnrichment(SONNET_TAIL)
    expect(currentModel(e, { model: null, startedAt: Date.now() })).toBe('claude-sonnet-5-5')
    expect(currentModel(e, null)).toBe('claude-sonnet-5-5')
  })

  it('sem resposta nenhuma ainda: o --model do spawn', () => {
    const e = deriveEnrichment('')
    expect(currentModel(e, { model: 'haiku', startedAt: 1 })).toBe('haiku')
  })
})
