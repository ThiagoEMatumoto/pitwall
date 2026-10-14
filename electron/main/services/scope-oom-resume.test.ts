/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScopeOomEvent } from '../../../shared/types/ipc'
import {
  OOM_AUTO_RESUME_WINDOW_MS,
  OOM_RESUME_GAP_MS,
  OOM_RESUME_MAX_WAIT_MS,
  OOM_RESUME_PRESSURE_MAX,
  OOM_RESUME_RETRY_MS,
  OomAutoResume,
} from './scope-oom-resume'

const CC = '11111111-2222-3333-4444-555555555555'
const CC2 = '22222222-2222-3333-4444-555555555555'
const CC3 = '33333333-2222-3333-4444-555555555555'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  vi.useRealTimers()
})

function policy(pressure: () => number | null = () => null) {
  const ccs: Record<string, string> = { s1: CC, s2: CC, a: CC, b: CC2, c: CC3 }
  const dispatched: ScopeOomEvent[] = []
  const auto = new OomAutoResume({
    ccOf: (id) => ccs[id] ?? null,
    slicePressure: pressure,
    dispatch: (e) => dispatched.push(e),
  })
  const dead = (sessionId: string) => auto.annotate({ sessionId, maxGB: 18, claudeAlive: false })
  return { auto, dead, dispatched }
}

describe('OomAutoResume', () => {
  it('claude morto: retoma a conversa 1 vez e não de novo dentro de 10 min', () => {
    const { dead } = policy()
    expect(dead('s1')).toEqual({
      sessionId: 's1',
      maxGB: 18,
      claudeAlive: false,
      resumeCcSessionId: CC,
    })
    // A sessão retomada (sessions.id novo, mesmo cc) estoura de novo 5 min depois.
    vi.advanceTimersByTime(5 * 60_000)
    expect(dead('s2')).toEqual({ sessionId: 's2', maxGB: 18, claudeAlive: false })
    vi.advanceTimersByTime(OOM_AUTO_RESUME_WINDOW_MS)
    expect(dead('s2').resumeCcSessionId).toBe(CC)
  })

  it('claude vivo ou sessão sem conversa: só o aviso', () => {
    const { auto } = policy()
    expect(auto.annotate({ sessionId: 's1', maxGB: 18, claudeAlive: true })).toEqual({
      sessionId: 's1',
      maxGB: 18,
      claudeAlive: true,
    })
    expect(auto.annotate({ sessionId: 'sem-cc', maxGB: 18, claudeAlive: false })).toEqual({
      sessionId: 'sem-cc',
      maxGB: 18,
      claudeAlive: false,
    })
  })

  // Um OOM do slice pode derrubar várias sessões de uma vez: todas fazendo
  // --resume juntas recriariam a mesma pressão que as matou.
  it('OOM coletivo: um resume por vez, com intervalo entre eles', () => {
    const { dead, dispatched } = policy()
    expect(dead('a').resumeCcSessionId).toBe(CC)
    const b = dead('b')
    const c = dead('c')
    expect(b.resumeCcSessionId).toBeUndefined()
    expect(b.resumeQueued).toBe(true)
    expect(c.resumeQueued).toBe(true)
    expect(dispatched).toEqual([])

    vi.advanceTimersByTime(OOM_RESUME_GAP_MS - 1)
    expect(dispatched).toEqual([])
    vi.advanceTimersByTime(1)
    expect(dispatched.map((e) => e.resumeCcSessionId)).toEqual([CC2])
    expect(dispatched[0]).toMatchObject({ sessionId: 'b', claudeAlive: false })
    expect(dispatched[0]!.resumeQueued).toBeUndefined()

    vi.advanceTimersByTime(OOM_RESUME_GAP_MS)
    expect(dispatched.map((e) => e.resumeCcSessionId)).toEqual([CC2, CC3])
    vi.advanceTimersByTime(10 * OOM_RESUME_GAP_MS)
    expect(dispatched).toHaveLength(2)
  })

  it(`slice acima de ${OOM_RESUME_PRESSURE_MAX * 100}% do teto: segura até baixar`, () => {
    let pressure: number | null = 0.9
    const { dead, dispatched } = policy(() => pressure)
    const e = dead('a')
    expect(e.resumeCcSessionId).toBeUndefined()
    expect(e.resumeQueued).toBe(true)
    vi.advanceTimersByTime(5 * OOM_RESUME_RETRY_MS)
    expect(dispatched).toEqual([])
    pressure = 0.5
    vi.advanceTimersByTime(OOM_RESUME_RETRY_MS)
    expect(dispatched.map((x) => x.resumeCcSessionId)).toEqual([CC])
  })

  // Fila presa por pressão que não baixa: depois do prazo o item sai e o renderer
  // recebe o evento sem resume, como no caso não enfileirado (toast "retome").
  it('item que espera mais que o prazo sai da fila e vira aviso sem resume', () => {
    expect(OOM_RESUME_MAX_WAIT_MS).toBe(5 * 60_000)
    const { dead, dispatched } = policy(() => 0.95)
    expect(dead('a').resumeQueued).toBe(true)
    vi.advanceTimersByTime(OOM_RESUME_MAX_WAIT_MS)
    expect(dispatched).toEqual([])
    vi.advanceTimersByTime(OOM_RESUME_RETRY_MS)
    expect(dispatched).toEqual([{ sessionId: 'a', maxGB: 18, claudeAlive: false }])
    vi.advanceTimersByTime(10 * OOM_RESUME_RETRY_MS)
    expect(dispatched).toHaveLength(1)
  })

  // A pane morta fechada com o resume na fila: o dispatch depois reabriria a
  // conversa sem repo, numa pane que o usuário já descartou.
  it('cancel tira da fila o resume da sessão encerrada', () => {
    const { auto, dead, dispatched } = policy(() => 0.95)
    dead('a')
    dead('b')
    auto.cancel('a')
    auto.cancel('nao-enfileirada')
    vi.advanceTimersByTime(OOM_RESUME_RETRY_MS)
    expect(dispatched).toEqual([])
    vi.advanceTimersByTime(OOM_RESUME_MAX_WAIT_MS + OOM_RESUME_RETRY_MS)
    expect(dispatched).toEqual([{ sessionId: 'b', maxGB: 18, claudeAlive: false }])
  })

  it('cancel do único item: nenhum dispatch nem com a pressão baixa', () => {
    let pressure = 0.95
    const { auto, dead, dispatched } = policy(() => pressure)
    dead('a')
    auto.cancel('a')
    pressure = 0.1
    vi.advanceTimersByTime(OOM_RESUME_MAX_WAIT_MS + 10 * OOM_RESUME_RETRY_MS)
    expect(dispatched).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sem leitura do slice (null), não segura', () => {
    const { dead } = policy(() => null)
    expect(dead('a').resumeCcSessionId).toBe(CC)
  })

  it('a conversa já na fila não entra de novo', () => {
    const { dead, dispatched } = policy()
    dead('b')
    dead('a')
    expect(dead('s1').resumeQueued).toBeUndefined()
    vi.advanceTimersByTime(5 * OOM_RESUME_GAP_MS)
    expect(dispatched.map((e) => e.resumeCcSessionId)).toEqual([CC])
  })
})
