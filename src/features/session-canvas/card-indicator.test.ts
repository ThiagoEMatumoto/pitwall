import { describe, expect, it } from 'vitest'
import {
  advanceWorkingClocks,
  cardIndicator,
  indicatorText,
  mapCounters,
  shortDuration,
  type IndicatorInput,
} from './card-indicator'

const NOW = 10_000_000

function input(patch: Partial<IndicatorInput>): IndicatorInput {
  return {
    status: 'idle',
    graphAttention: null,
    lastActivityAt: NOW - 120_000,
    workingSince: null,
    ...patch,
  }
}

describe('cardIndicator', () => {
  it('trabalhando: desde quando entrou em working, com o passo atual (1ª linha do último texto)', () => {
    const ind = cardIndicator(
      input({
        status: 'working',
        workingSince: NOW - 180_000,
        lastText: '\n  Rodando os testes do canvas\nsegunda linha',
      }),
    )
    expect(ind).toEqual({
      tone: 'working',
      reason: null,
      step: 'Rodando os testes do canvas',
      sinceAt: NOW - 180_000,
    })
    expect(indicatorText(ind, NOW)).toBe('trabalhando há 3m')
  })

  it('precisa de você, com o motivo parseado da tela', () => {
    const cases: Array<[IndicatorInput['detail'], string]> = [
      ['permission', 'Permissão'],
      ['question', 'Pergunta'],
      ['trust', 'Confiar'],
    ]
    for (const [detail, reason] of cases) {
      const ind = cardIndicator(input({ status: 'waiting', detail }))
      expect(ind.tone).toBe('needs-you')
      expect(ind.reason).toBe(reason)
    }
  })

  it('a pergunta do handoff vence o PTY trabalhando', () => {
    const ind = cardIndicator(input({ status: 'working', graphAttention: 'handoff-input' }))
    expect(ind).toMatchObject({ tone: 'needs-you', reason: 'Pergunta pendente' })
    expect(indicatorText(ind, NOW)).toBe('precisa de você')
  })

  it('terminou o turno: pronto há N', () => {
    const ind = cardIndicator(input({ status: 'waiting', detail: 'turn-end' }))
    expect(ind.tone).toBe('done')
    expect(indicatorText(ind, NOW)).toBe('pronto · há 2m')
    expect(cardIndicator(input({ status: 'idle' })).tone).toBe('done')
  })

  it('waiting sem tela reconhecida não é dado como pronto', () => {
    expect(cardIndicator(input({ status: 'waiting' }))).toMatchObject({
      tone: 'needs-you',
      reason: 'Esperando você',
    })
  })

  it('subindo e interrompida', () => {
    expect(cardIndicator(input({ status: 'starting' })).tone).toBe('starting')
    const tail = ['● Edit(foo.ts)', '  ⎿  Interrupted · What should Claude do instead?', '', '> ']
    const ind = cardIndicator(input({ status: 'idle', tail }))
    expect(ind.tone).toBe('interrupted')
    // Trabalhando de novo, a marca antiga na tela não conta.
    expect(cardIndicator(input({ status: 'working', tail })).tone).toBe('working')
  })
})

describe('relógio e contadores', () => {
  it('working since: fixa ao entrar em working, zera ao sair', () => {
    const a = advanceWorkingClocks(new Map(), [{ sessionId: 's', status: 'working' }], 100)
    expect(a.get('s')).toBe(100)
    const b = advanceWorkingClocks(a, [{ sessionId: 's', status: 'working' }], 500)
    expect(b.get('s')).toBe(100)
    const c = advanceWorkingClocks(b, [{ sessionId: 's', status: 'waiting' }], 600)
    expect(c.get('s')).toBeNull()
    const d = advanceWorkingClocks(c, [{ sessionId: 's', status: 'working' }], 700)
    expect(d.get('s')).toBe(700)
  })

  it('contadores da barra do mapa', () => {
    expect(mapCounters(['working', 'working', 'needs-you', 'done', 'starting', 'done'])).toEqual({
      working: 2,
      needsYou: 1,
      done: 2,
    })
  })

  it('duração curta', () => {
    expect(shortDuration(45_000)).toBe('45s')
    expect(shortDuration(3 * 60_000)).toBe('3m')
    expect(shortDuration(2 * 3_600_000)).toBe('2h')
    expect(shortDuration(50 * 3_600_000)).toBe('2d')
  })
})
