import { describe, expect, it } from 'vitest'
import { STALLED_THRESHOLD_DAYS } from './feature-visibility'
import {
  issuesOf,
  lastActivityAt,
  livenessOf,
  metricTone,
  type Liveness,
  type LoopInput,
  type MetricConfig,
  type MetricTone,
} from './feature-loop'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

// Input "vivo e saudável": tocado agora, com pulso, objetivo e repo — nenhuma
// issue de erro. Cada caso liga só o que quer testar.
function input(overrides: Partial<LoopInput> = {}): LoopInput {
  return {
    status: 'in-progress',
    updatedAt: NOW,
    objective: 'Derivar o status do loop em vez de declará-lo',
    pulse: { body: 'Portando o cálculo de liveness', source: 'human' },
    repos: [{ repoId: 'r1' }],
    ...overrides,
  }
}

describe('lastActivityAt', () => {
  it('takes the max across every available timestamp', () => {
    expect(
      lastActivityAt({
        updatedAt: NOW - 5 * DAY_MS,
        lastRecordAt: NOW - 3 * DAY_MS,
        lastPulseAt: NOW - 9 * DAY_MS,
        lastLedgerAt: NOW - DAY_MS,
        lastMetricPointAt: NOW - 2 * DAY_MS,
        docMtime: NOW - 4 * DAY_MS,
      }),
    ).toBe(NOW - DAY_MS)
  })

  it('ignores absent and null fields (falls back to updatedAt)', () => {
    expect(lastActivityAt({ updatedAt: NOW })).toBe(NOW)
    expect(
      lastActivityAt({ updatedAt: NOW, lastRecordAt: null, lastPulseAt: undefined, docMtime: null }),
    ).toBe(NOW)
  })

  it.each([
    ['lastRecordAt', { lastRecordAt: NOW }],
    ['lastPulseAt', { lastPulseAt: NOW }],
    ['lastLedgerAt', { lastLedgerAt: NOW }],
    ['lastMetricPointAt', { lastMetricPointAt: NOW }],
    ['docMtime', { docMtime: NOW }],
  ])('%s alone can beat a stale updatedAt', (_label, extra) => {
    expect(lastActivityAt({ updatedAt: NOW - 30 * DAY_MS, ...extra })).toBe(NOW)
  })
})

describe('livenessOf — precedence', () => {
  const brokenPulse = { body: 'x'.repeat(201) }
  const cases: [string, Partial<LoopInput>, Liveness][] = [
    ['status paused', { status: 'paused' }, 'paused'],
    ['pausedAt stamped', { pausedAt: NOW - DAY_MS }, 'paused'],
    ['error issue → broken', { pulse: brokenPulse }, 'broken'],
    ['status done', { status: 'done' }, 'done'],
    ['completedAt stamped', { completedAt: NOW - DAY_MS }, 'done'],
    ['stale beyond cadence', { updatedAt: NOW - 30 * DAY_MS }, 'quiet'],
    ['touched now', {}, 'alive'],
  ]

  it.each(cases)('%s → %s', (_label, overrides, expected) => {
    expect(livenessOf(input(overrides), NOW)).toBe(expected)
  })

  it('paused wins over broken, done and quiet', () => {
    expect(
      livenessOf(
        input({
          status: 'paused',
          completedAt: NOW - DAY_MS,
          pulse: { body: 'x'.repeat(201) },
          updatedAt: NOW - 90 * DAY_MS,
        }),
        NOW,
      ),
    ).toBe('paused')
  })

  it('broken wins over done and quiet', () => {
    expect(
      livenessOf(
        input({ status: 'done', pulse: { body: 'x'.repeat(201) }, updatedAt: NOW - 90 * DAY_MS }),
        NOW,
      ),
    ).toBe('broken')
  })

  it('done wins over quiet', () => {
    expect(livenessOf(input({ status: 'done', updatedAt: NOW - 90 * DAY_MS }), NOW)).toBe('done')
  })

  it('warn/info issues do not make it broken', () => {
    expect(livenessOf(input({ pulse: null, objective: null, repos: [] }), NOW)).toBe('alive')
  })

  it('defaults now to Date.now()', () => {
    expect(livenessOf(input({ updatedAt: Date.now() }))).toBe('alive')
  })
})

describe('livenessOf — quiet threshold', () => {
  const defaultMs = STALLED_THRESHOLD_DAYS * DAY_MS

  it('is quiet exactly at the cadence boundary (>=)', () => {
    expect(livenessOf(input({ updatedAt: NOW - defaultMs }), NOW)).toBe('quiet')
  })

  it('is still alive 1ms before the boundary', () => {
    expect(livenessOf(input({ updatedAt: NOW - defaultMs + 1 }), NOW)).toBe('alive')
  })

  it('uses cadenceDays from the input when present', () => {
    const threeDays = 3 * DAY_MS
    expect(livenessOf(input({ cadenceDays: 3, updatedAt: NOW - threeDays }), NOW)).toBe('quiet')
    expect(livenessOf(input({ cadenceDays: 3, updatedAt: NOW - threeDays + 1 }), NOW)).toBe('alive')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['negative', -5],
  ])('falls back to STALLED_THRESHOLD_DAYS when cadenceDays is %s', (_label, cadenceDays) => {
    expect(livenessOf(input({ cadenceDays, updatedAt: NOW - defaultMs + 1 }), NOW)).toBe('alive')
    expect(livenessOf(input({ cadenceDays, updatedAt: NOW - defaultMs }), NOW)).toBe('quiet')
  })

  it('a fresh pulse alone keeps a stale feature alive', () => {
    expect(livenessOf(input({ updatedAt: NOW - 90 * DAY_MS, lastPulseAt: NOW }), NOW)).toBe('alive')
  })
})

describe('issuesOf', () => {
  function codes(overrides: Partial<LoopInput>): string[] {
    return issuesOf(input(overrides)).map((i) => i.code)
  }

  const cases: [string, Partial<LoopInput>, string][] = [
    ['pulse over 200 chars', { pulse: { body: 'x'.repeat(201) } }, 'pulse_too_long'],
    ['ledger id with invalid char', { ledger: [{ entryId: 'bad id!' }] }, 'ledger_id_invalid'],
    ['ledger id starting with dash', { ledger: [{ entryId: '-lead' }] }, 'ledger_id_invalid'],
    ['ledger id over 80 chars', { ledger: [{ entryId: 'a'.repeat(81) }] }, 'ledger_id_invalid'],
    ['ledger id empty', { ledger: [{ entryId: '' }] }, 'ledger_id_invalid'],
    [
      'metric point without declared column',
      { metrics: [{ columnKey: 'cost' }], metricPoints: [{ columnKey: 'latency', at: NOW }] },
      'metric_point_orphan',
    ],
    ['no pulse', { pulse: null }, 'pulse_missing'],
    ['blank pulse', { pulse: { body: '   ' } }, 'pulse_missing'],
    ['objective null', { objective: null }, 'objective_missing'],
    ['objective blank', { objective: '  ' }, 'objective_missing'],
    ['objective over 400 chars', { objective: 'o'.repeat(401) }, 'objective_too_long'],
    [
      'duplicate suspect registered',
      { duplicateSuspect: { featureId: 'F2', title: 'Login', score: 0.62 } },
      'duplicate_suspect',
    ],
    ['no repo linked', { repos: [] }, 'no_repo_linked'],
    ['repos absent', { repos: undefined }, 'no_repo_linked'],
  ]

  it.each(cases)('%s → %s', (_label, overrides, code) => {
    expect(codes(overrides)).toContain(code)
  })

  it('healthy input has no issue at all', () => {
    expect(issuesOf(input())).toEqual([])
  })

  it.each([
    ['plain', 'abc'],
    ['dots, dashes, underscores', 'a.b-c_d1'],
    ['single char', 'x'],
    ['exactly 80 chars', 'a'.repeat(80)],
  ])('accepts valid ledger id (%s)', (_label, entryId) => {
    expect(codes({ ledger: [{ entryId }] })).not.toContain('ledger_id_invalid')
  })

  it('pulse exactly at the limit is fine; one char over is not', () => {
    expect(codes({ pulse: { body: 'x'.repeat(200) } })).not.toContain('pulse_too_long')
    expect(codes({ pulse: { body: 'x'.repeat(201) } })).toContain('pulse_too_long')
  })

  it('objective exactly at the limit is fine; one char over is not', () => {
    expect(codes({ objective: 'o'.repeat(400) })).not.toContain('objective_too_long')
    expect(codes({ objective: 'o'.repeat(401) })).toContain('objective_too_long')
  })

  it('a blank pulse reports missing, not too long', () => {
    expect(codes({ pulse: { body: ' '.repeat(300) } })).toEqual(
      expect.arrayContaining(['pulse_missing']),
    )
    expect(codes({ pulse: { body: ' '.repeat(300) } })).not.toContain('pulse_too_long')
  })

  it('aggregates repeated violations into a single issue per code', () => {
    const issues = issuesOf(
      input({
        ledger: [{ entryId: 'bad one' }, { entryId: 'bad two' }, { entryId: '!x' }, { entryId: 'ok' }],
        metrics: [],
        metricPoints: [{ columnKey: 'a', at: NOW }, { columnKey: 'b', at: NOW }],
      }),
    )
    expect(issues.filter((i) => i.code === 'ledger_id_invalid')).toHaveLength(1)
    expect(issues.filter((i) => i.code === 'metric_point_orphan')).toHaveLength(1)
    expect(issues.find((i) => i.code === 'ledger_id_invalid')?.message).toContain('3 entrada(s)')
  })

  it('declared columns accept their own points', () => {
    expect(
      codes({ metrics: [{ columnKey: 'cost' }], metricPoints: [{ columnKey: 'cost', at: NOW }] }),
    ).not.toContain('metric_point_orphan')
  })

  it('duplicate_suspect names the candidate and its affinity', () => {
    const issue = issuesOf(
      input({ duplicateSuspect: { featureId: 'F2', title: 'Login social', score: 0.62 } }),
    ).find((i) => i.code === 'duplicate_suspect')
    expect(issue?.level).toBe('warn')
    expect(issue?.message).toContain('«Login social»')
    expect(issue?.message).toContain('62%')
  })

  it('duplicate_suspect degrades to the id and omits the affinity when absent', () => {
    const issue = issuesOf(input({ duplicateSuspect: { featureId: 'F2', title: '  ' } })).find(
      (i) => i.code === 'duplicate_suspect',
    )
    expect(issue?.message).toBe('Possível duplicata de «F2».')
  })

  it('no suspect, no issue — and a suspect never makes the feature broken', () => {
    expect(codes({ duplicateSuspect: null })).not.toContain('duplicate_suspect')
    expect(codes({})).not.toContain('duplicate_suspect')
    expect(
      livenessOf(input({ duplicateSuspect: { featureId: 'F2' }, updatedAt: NOW }), NOW),
    ).toBe('alive')
  })

  it('orders issues error → warn → info', () => {
    const levels = issuesOf(
      input({ ledger: [{ entryId: 'bad id!' }], pulse: null, objective: null, repos: [] }),
    ).map((i) => i.level)
    expect(levels).toEqual(['error', 'warn', 'warn', 'info'])
  })
})

describe('metricTone', () => {
  const cases: [string, number, MetricConfig, MetricTone][] = [
    ['below floor', 4, { floor: 5, target: 10 }, 'fail'],
    ['exactly at floor', 5, { floor: 5, target: 100 }, 'neutral'],
    ['alarm column above target', 12, { target: 10, alarm: true }, 'fail'],
    ['alarm column exactly at target', 10, { target: 10, alarm: true }, 'ok'],
    ['non-alarm column just above target', 11, { target: 10 }, 'ok'],
    ['non-alarm column far above target is never fail', 40, { target: 10 }, 'neutral'],
    ['within 15% below target', 87, { target: 100 }, 'ok'],
    ['exactly 15% below target', 85, { target: 100 }, 'ok'],
    ['just outside 15%', 84.9, { target: 100 }, 'neutral'],
    ['far from target', 40, { target: 100 }, 'neutral'],
    ['floor absent, target met', 100, { target: 100 }, 'ok'],
    ['floor absent, far from target', 10, { target: 100 }, 'neutral'],
    ['target absent, above floor', 50, { floor: 10 }, 'neutral'],
    ['no target and no floor', 50, {}, 'neutral'],
    ['null floor and null target', 50, { floor: null, target: null }, 'neutral'],
    ['target 0, value 0', 0, { target: 0 }, 'ok'],
    ['target 0, value near zero', 0.5, { target: 0 }, 'neutral'],
    ['target 0, alarm, positive value', 0.5, { target: 0, alarm: true }, 'fail'],
    ['target 0, alarm, value 0', 0, { target: 0, alarm: true }, 'ok'],
    ['negative target within 15%', -95, { target: -100 }, 'ok'],
    ['floor wins over alarm target', -1, { floor: 0, target: 10, alarm: true }, 'fail'],
  ]

  it.each(cases)('%s → %s', (_label, value, cfg, expected) => {
    expect(metricTone(value, cfg)).toBe(expected)
  })
})
