import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Prova de "HUD = Crew Dock = Ctrl+`": as três contagens saem da MESMA lista,
// produzida pelo caminho real (handoffStore sobre banco migrado, mapper do main,
// telas capturadas do claude) — nenhum Handoff/estado montado à mão.
let testDb: Database.Database
vi.mock('../../../electron/main/services/db', () => ({ getDb: () => testDb }))
let transcriptPath: string | null = null
vi.mock('../../../electron/main/services/transcript-path', () => ({
  findTranscriptPath: () => transcriptPath,
}))
vi.mock('../../../electron/main/services/session-activity', () => ({
  buildSessionsFileIndex: () => new Map(),
}))
vi.mock('../../../electron/main/services/live-session-states', () => ({
  liveSessionStates: () => new Map(),
}))

// crew.ts → handoffsStore → @/lib/ipc lê window.api no module-eval.
vi.stubGlobal('window', {
  ...globalThis.window,
  api: new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) }),
})

const store = await import('../../../electron/main/services/handoff-store')
const { readTransitions, toAttentionLive } =
  await import('../../../electron/main/services/attention/attention-service')
const { buildSessionGraph, readSessionGraphInput } =
  await import('../../../electron/main/services/session-graph')
const harness = await import('../../../electron/main/services/attention/attention-test-harness')
const { projectAttention } = await import('../../../shared/attention/project-attention')
const { attentionCount, buildAttentionQueue } = await import('./attention-queue')
const { crewAttentionCount } = await import('@/features/handoffs/crew')
const { buildSwitcherEntries } = await import('@/features/session-canvas/feature-switcher-model')
const { sessionStatusCounts } = await import('@/features/session-canvas/feature-state-summary')

type LiveStatus = import('../../../shared/tui/attention-reason').LiveStatus
type ScreenScan = import('../../../shared/tui/attention-reason').ScreenScan
type LiveSessionState = import('../../../electron/main/services/session-graph').LiveSessionState

const F = 'F'

interface Live {
  id: string
  status: LiveStatus
  scan: ScreenScan | null
}

function child(repo: string, sid: string) {
  harness.seedSession(testDb, sid, { repoId: repo, featureId: F })
  const h = store.create({
    targetRepoId: repo,
    motherSessionId: 'M',
    featureId: F,
    task: `task ${sid}`,
    composedPrompt: 'p',
  })
  return store.markRunning(h.id, sid)
}

function surfaces(lives: Live[]) {
  const states = new Map<string, LiveSessionState>(
    lives.map((l) => [l.id, { status: l.status, lastActivityAt: 1_000, name: null }]),
  )
  const rows = testDb
    .prepare(
      'SELECT id, feature_id, repo_id FROM sessions WHERE id IN (SELECT value FROM json_each(?))',
    )
    .all(JSON.stringify(lives.map((l) => l.id))) as Array<{
    id: string
    feature_id: string | null
    repo_id: string | null
  }>
  const scanOf = new Map(lives.map((l) => [l.id, l.scan]))
  const live = rows.map((r) => {
    const scan = scanOf.get(r.id) ?? null
    return toAttentionLive(r, states.get(r.id)!, scan, scan?.menu ? 1 : null)
  })
  const handoffs = store.list()
  const items = projectAttention({ handoffs, transitions: readTransitions(testDb, handoffs), live })

  // Lado do renderer: a LiveSessionInfo é o único shape sintético (toLiveInfo).
  const infos = live.map((s) => harness.toLiveInfo(testDb, s))
  const childIds = new Set(handoffs.flatMap((h) => (h.childSessionId ? [h.childSessionId] : [])))
  const visibleSessions = infos.filter((i) => !childIds.has(i.id))
  const graph = buildSessionGraph({ ...readSessionGraphInput(testDb, states), attention: items })
  const liveBits = new Map(infos.map((i) => [i.id, i]))

  return {
    items,
    graph,
    hud: attentionCount(
      buildAttentionQueue({ visibleSessions, liveSessions: infos, handoffs, attention: items }),
    ),
    dock: crewAttentionCount(items, handoffs),
    switcher: buildSwitcherEntries(graph, liveBits, () => null, undefined, items).reduce(
      (sum, e) => sum + e.needsYou,
      0,
    ),
  }
}

describe('HUD = Crew Dock = Ctrl+` (a mesma lista)', () => {
  let permission: ScreenScan
  let idle: ScreenScan

  beforeEach(async () => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    harness.applyAllMigrations(testDb)
    harness.seedRepos(testDb)
    harness.seedFeature(testDb, F)
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    transcriptPath = null
    permission = await harness.scanFixture('permission-bash')
    idle = await harness.scanFixture('idle-prompt')

    // A: pergunta aberta. B: perguntou e retomou (progress posterior).
    // C: fim de turno na tela. D: menu de permissão na tela.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(10_000)
      store.ask(child('r1', 'A').id, 'qual branch?')
      const b = child('r2', 'B')
      store.ask(b.id, 'posso apagar?')
      vi.setSystemTime(20_000)
      store.progress(b.id, 'segui sem apagar')
      child('r3', 'C')
      child('r4', 'D')
    } finally {
      vi.useRealTimers()
    }
  })
  afterEach(() => testDb.close())

  const crewLives = (): Live[] => [
    { id: 'M', status: 'idle', scan: null },
    { id: 'A', status: 'working', scan: null },
    { id: 'B', status: 'working', scan: null },
    { id: 'C', status: 'waiting', scan: idle },
    { id: 'D', status: 'waiting', scan: permission },
  ]

  it('só crew: os três números são iguais (A e D; B retomada e C em fim de turno ficam fora)', () => {
    const s = surfaces(crewLives())
    expect(s.hud).toBe(2)
    expect(s.dock).toBe(2)
    expect(s.switcher).toBe(2)
    expect(sessionStatusCounts(s.graph.nodes, F).needsYou).toBe(2)
  })

  it('sessão avulsa (não-crew) em menu: HUD = switcher = 3, dock = 2, a diferença é o item sem handoff', () => {
    harness.seedSession(testDb, 'X', { repoId: 'r5' })
    const s = surfaces([...crewLives(), { id: 'X', status: 'waiting', scan: permission }])
    expect(s.hud).toBe(3)
    expect(s.switcher).toBe(3)
    expect(s.dock).toBe(2)
    expect(s.hud - s.dock).toBe(s.items.filter((i) => i.severity !== 'info' && !i.handoffId).length)
  })

  it('filha interrompida retomável (sem PTY) conta nas três superfícies pela feature', () => {
    const e = child('r5', 'E')
    store.failIfRunning(e.id, 'PTY morreu')
    transcriptPath = '/tmp/e.jsonl'
    const s = surfaces(crewLives())
    expect(s.items.some((i) => i.kind === 'child_interrupted')).toBe(true)
    expect(s.hud).toBe(3)
    expect(s.dock).toBe(3)
    expect(s.switcher).toBe(3)
  })
})
