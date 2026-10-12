/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { OOM_AUTO_RESUME_WINDOW_MS, OomAutoResume } from './scope-oom-resume'

const CC = '11111111-2222-3333-4444-555555555555'

function policy() {
  let now = 1_000_000
  const ccs: Record<string, string> = { s1: CC, s2: CC }
  const auto = new OomAutoResume({ ccOf: (id) => ccs[id] ?? null, now: () => now })
  return { auto, advance: (ms: number) => (now += ms) }
}

describe('OomAutoResume', () => {
  it('claude morto: retoma a conversa 1 vez e não de novo dentro de 10 min', () => {
    const { auto, advance } = policy()
    const resumes: string[] = []
    const fire = (sessionId: string) => {
      const e = auto.annotate({ sessionId, maxGB: 18, claudeAlive: false })
      if (e.resumeCcSessionId) resumes.push(e.resumeCcSessionId)
      return e
    }
    expect(fire('s1')).toEqual({
      sessionId: 's1',
      maxGB: 18,
      claudeAlive: false,
      resumeCcSessionId: CC,
    })
    // A sessão retomada (sessions.id novo, mesmo cc) estoura de novo 5 min depois.
    advance(5 * 60_000)
    expect(fire('s2')).toEqual({ sessionId: 's2', maxGB: 18, claudeAlive: false })
    expect(resumes).toEqual([CC])
    advance(OOM_AUTO_RESUME_WINDOW_MS)
    fire('s2')
    expect(resumes).toEqual([CC, CC])
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
})
