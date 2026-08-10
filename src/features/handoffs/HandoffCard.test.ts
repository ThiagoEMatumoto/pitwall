import { describe, expect, it } from 'vitest'

// HandoffCard importa @/lib/ipc, que lê window.api no module-eval. As funções
// puras testadas aqui não tocam a API, mas o import precisa de um stub mínimo.
// Stub ANTES do import dinâmico do componente (top-level await garante a ordem).
import { vi } from 'vitest'
vi.stubGlobal('window', {
  ...globalThis.window,
  api: new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) }),
})

const { isStale, staleLabel, liveActivityLabel, contextLabel, liveBadgeFor } = await import(
  './HandoffCard'
)
type Handoff = import('../../../shared/types/ipc').Handoff

// now fixo/determinístico — nunca Date.now() real.
const now = 1_000_000_000_000
const HOUR = 3_600_000

// Cast mínimo: só preenchemos os campos lidos por isStale/staleLabel.
const mk = (over: Partial<Handoff>) => ({ ...over }) as Handoff

describe('liveBadgeFor', () => {
  it('working → trabalhando, info, sem attention', () => {
    expect(liveBadgeFor('working')).toEqual({
      label: 'trabalhando',
      color: 'var(--color-info)',
      attention: false,
    })
  })

  it('waiting → aguardando você, warning/âmbar, com attention', () => {
    expect(liveBadgeFor('waiting')).toEqual({
      label: 'aguardando você',
      color: 'var(--color-warning)',
      attention: true,
    })
  })

  it('starting → iniciando, info, sem attention', () => {
    expect(liveBadgeFor('starting')).toEqual({
      label: 'iniciando',
      color: 'var(--color-info)',
      attention: false,
    })
  })

  it('idle → ociosa, text-dim, sem attention', () => {
    expect(liveBadgeFor('idle')).toEqual({
      label: 'ociosa',
      color: 'var(--color-text-dim)',
      attention: false,
    })
  })

  it('ended → filha encerrou, danger, com attention', () => {
    expect(liveBadgeFor('ended')).toEqual({
      label: 'filha encerrou',
      color: 'var(--color-danger)',
      attention: true,
    })
  })

  it('undefined → igual a ended (filha encerrou, danger, attention)', () => {
    expect(liveBadgeFor(undefined)).toEqual({
      label: 'filha encerrou',
      color: 'var(--color-danger)',
      attention: true,
    })
  })
})

describe('liveActivityLabel', () => {
  it('at=null → null', () => {
    expect(liveActivityLabel(null, now)).toBeNull()
  })

  it('0s → "há 0s"', () => {
    expect(liveActivityLabel(now, now)).toBe('há 0s')
  })

  it('<60s → segundos', () => {
    expect(liveActivityLabel(now - 30_000, now)).toBe('há 30s')
  })

  it('90s → "há 2min" (round)', () => {
    // s=90 → m=round(90/60)=round(1.5)=2
    expect(liveActivityLabel(now - 90_000, now)).toBe('há 2min')
  })

  it('59min ainda em minutos', () => {
    expect(liveActivityLabel(now - 59 * 60_000, now)).toBe('há 59min')
  })

  it('2h → "há 2h"', () => {
    expect(liveActivityLabel(now - 2 * HOUR, now)).toBe('há 2h')
  })

  it('futuro/relógio adiantado é clampeado em 0s (Math.max)', () => {
    expect(liveActivityLabel(now + 5_000, now)).toBe('há 0s')
  })
})

describe('contextLabel', () => {
  it('tokens undefined → null', () => {
    expect(contextLabel(undefined)).toBeNull()
  })

  it('context=0 → "0 ctx" (0 != null, não retorna null)', () => {
    // == null só pega null/undefined; 0 passa pelo guard e cai no else.
    expect(contextLabel({ output: 0, context: 0 })).toBe('0 ctx')
  })

  it('900 → "900 ctx"', () => {
    expect(contextLabel({ output: 0, context: 900 })).toBe('900 ctx')
  })

  it('1000 → "1k ctx"', () => {
    expect(contextLabel({ output: 0, context: 1000 })).toBe('1k ctx')
  })

  it('128000 → "128k ctx"', () => {
    expect(contextLabel({ output: 0, context: 128000 })).toBe('128k ctx')
  })
})

describe('isStale', () => {
  it('status não-running → false', () => {
    expect(isStale(mk({ status: 'done', updatedAt: now - 10 * HOUR }), 2, now)).toBe(false)
  })

  it('running dentro do TTL → false', () => {
    expect(isStale(mk({ status: 'running', updatedAt: now - 1 * HOUR }), 2, now)).toBe(false)
  })

  it('running além do TTL → true', () => {
    expect(isStale(mk({ status: 'running', updatedAt: now - 3 * HOUR }), 2, now)).toBe(true)
  })

  it('usa stepUpdatedAt quando presente (recente → false mesmo com updatedAt velho)', () => {
    expect(
      isStale(
        mk({ status: 'running', stepUpdatedAt: now - 1 * HOUR, updatedAt: now - 10 * HOUR }),
        2,
        now,
      ),
    ).toBe(false)
  })

  it('cai pra updatedAt quando stepUpdatedAt é null', () => {
    expect(
      isStale(mk({ status: 'running', stepUpdatedAt: null, updatedAt: now - 3 * HOUR }), 2, now),
    ).toBe(true)
  })
})

describe('staleLabel', () => {
  it('floor com mínimo 1h (30min → "sem progresso há 1h")', () => {
    expect(staleLabel(mk({ updatedAt: now - 30 * 60_000 }), now)).toBe('sem progresso há 1h')
  })

  it('várias horas com floor (3h30 → "sem progresso há 3h")', () => {
    expect(staleLabel(mk({ updatedAt: now - (3 * HOUR + 30 * 60_000) }), now)).toBe(
      'sem progresso há 3h',
    )
  })

  it('usa stepUpdatedAt quando presente', () => {
    expect(
      staleLabel(mk({ stepUpdatedAt: now - 5 * HOUR, updatedAt: now - 99 * HOUR }), now),
    ).toBe('sem progresso há 5h')
  })
})
