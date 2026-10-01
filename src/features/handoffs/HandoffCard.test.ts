import { describe, expect, it } from 'vitest'

// HandoffCard importa @/lib/ipc, que lê window.api no module-eval. As funções
// puras testadas aqui não tocam a API, mas o import precisa de um stub mínimo.
// Stub ANTES do import dinâmico do componente (top-level await garante a ordem).
import { vi } from 'vitest'
vi.stubGlobal('window', {
  ...globalThis.window,
  api: new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) }),
})

const { isStale, staleLabel, liveActivityLabel, contextLabel, liveBadgeFor, childIdentity, crewDotColor, crewDotTitle } = await import(
  './HandoffCard'
)
type Handoff = import('../../../shared/types/ipc').Handoff

// now fixo/determinístico — nunca Date.now() real.
const now = 1_000_000_000_000
const HOUR = 3_600_000

// Cast mínimo: só preenchemos os campos lidos por isStale/staleLabel.
const mk = (over: Partial<Handoff>) => ({ ...over }) as Handoff

describe('liveBadgeFor', () => {
  // O MESMO tom do cartão do mapa (cardIndicator): dock e cartão não divergem.
  it('working → trabalhando, info, sem attention', () => {
    expect(liveBadgeFor({ status: 'working' })).toEqual({
      label: 'trabalhando',
      color: 'var(--color-info)',
      attention: false,
    })
  })

  it('waiting com fim de turno reconhecido → pronto, success, sem attention', () => {
    expect(liveBadgeFor({ status: 'waiting', attentionReason: 'turn-end' })).toEqual({
      label: 'pronto',
      color: 'var(--color-success)',
      attention: false,
    })
  })

  it('waiting com menu (permissão) ou tela não reconhecida → precisa de você, danger', () => {
    const needsYou = { label: 'precisa de você', color: 'var(--color-danger)', attention: true }
    expect(liveBadgeFor({ status: 'waiting', attentionReason: 'permission' })).toEqual(needsYou)
    expect(liveBadgeFor({ status: 'waiting' })).toEqual(needsYou)
  })

  it('pergunta de handoff aberta vence o status do PTY', () => {
    expect(liveBadgeFor({ status: 'working' }, true).attention).toBe(true)
  })

  it('starting → subindo, info, sem attention', () => {
    expect(liveBadgeFor({ status: 'starting' })).toEqual({
      label: 'subindo',
      color: 'var(--color-info)',
      attention: false,
    })
  })

  it('ended/undefined → filha encerrou, danger, com attention', () => {
    const gone = { label: 'filha encerrou', color: 'var(--color-danger)', attention: true }
    expect(liveBadgeFor({ status: 'ended' })).toEqual(gone)
    expect(liveBadgeFor(undefined)).toEqual(gone)
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

describe('childIdentity (bastão de filha)', () => {
  const pred = { id: 'pred', title: 'ana-checkout', status: 'working' as const }
  const succ = { id: 'succ', title: 'ana-checkout', status: 'working' as const }

  it('sucessora no liveSessions: o apelido dela, sem pendência', () => {
    expect(
      childIdentity({ childSessionId: 'succ', predecessorSessionId: 'pred', updatedAt: 1_000 }, [pred, succ], 2_000),
    ).toEqual({
      title: 'ana-checkout',
      successorPending: false,
    })
  })

  it('sucessora ainda não chegou: apelido herdado da antecessora, nunca "filha encerrou"', () => {
    expect(
      childIdentity({ childSessionId: 'succ', predecessorSessionId: 'pred', updatedAt: 1_000 }, [pred], 2_000),
    ).toEqual({
      title: 'ana-checkout',
      successorPending: true,
    })
  })

  it('sucessora que não chega em 1 min não fica "assumindo" para sempre', () => {
    expect(
      childIdentity({ childSessionId: 'succ', predecessorSessionId: 'pred', updatedAt: 0 }, [pred], 61_000),
    ).toEqual({ title: null, successorPending: false })
  })

  it('sem bastão e sem filha viva: nada a herdar (o card segue "filha encerrou")', () => {
    expect(childIdentity({ childSessionId: 'x', predecessorSessionId: null, updatedAt: 0 }, [pred], 0)).toEqual({
      title: null,
      successorPending: false,
    })
  })
})

describe('trilha do dock no bastão de filha (crewDotTitle/crewDotColor)', () => {
  const pred = { id: 'pred', title: 'ana-checkout', status: 'running' } as never
  const handoff = {
    id: 'h1',
    status: 'running',
    resumable: false,
    childSessionId: 'succ',
    predecessorSessionId: 'pred',
    updatedAt: 1_000,
    targetRepoLabel: 'api',
    targetRepoId: 'r-api',
  } as never

  it('sucessora ainda fora de liveSessions: apelido da antecessora e "assumindo o bastão", não "despachando"', () => {
    const title = crewDotTitle(handoff, undefined, [pred], 2_000)
    expect(title).toContain('ana-checkout')
    expect(title).toContain('assumindo o bastão')
    expect(crewDotColor(handoff, undefined, [pred], 2_000)).toBe('var(--color-info)')
  })

  it('passada a janela, volta ao estado do handoff', () => {
    expect(crewDotTitle(handoff, undefined, [pred], 120_000)).toBe('api — despachando')
  })
})
