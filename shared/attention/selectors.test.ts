import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// itemsForFeature (Room) tem de dar o MESMO número que o card da feature no Ctrl+`.
// Estado produzido pelo caminho real: handoffStore sobre banco migrado, mapper do
// main e buildSessionGraph — nenhum AttentionItem/Handoff montado à mão.
let testDb: Database.Database
vi.mock('../../electron/main/services/db', () => ({ getDb: () => testDb }))
let transcriptPath: string | null = null
vi.mock('../../electron/main/services/transcript-path', () => ({
  findTranscriptPath: () => transcriptPath,
}))
vi.mock('../../electron/main/services/session-activity', () => ({
  buildSessionsFileIndex: () => new Map(),
}))
vi.mock('../../electron/main/services/live-session-states', () => ({
  liveSessionStates: () => new Map(),
}))

const store = await import('../../electron/main/services/handoff-store')
const { readRequestInput, readTransitions, toAttentionLive } =
  await import('../../electron/main/services/attention/attention-service')
const { buildSessionGraph, readSessionGraphInput } =
  await import('../../electron/main/services/session-graph')
const harness = await import('../../electron/main/services/attention/attention-test-harness')
const { projectAttention } = await import('./project-attention')
const { countAttentionSubjects, humanQueue, isAskItem, itemsForFeature } = await import('./selectors')
const { buildSwitcherEntries } =
  await import('../../src/features/session-canvas/feature-switcher-model')

type LiveStatus = import('../tui/attention-reason').LiveStatus
type LiveSessionState = import('../../electron/main/services/session-graph').LiveSessionState

const F = 'F'
const G = 'G'

function child(repo: string, sid: string, featureId: string, sessionFeature = featureId) {
  harness.seedSession(testDb, sid, { repoId: repo, featureId: sessionFeature })
  const h = store.create({
    targetRepoId: repo,
    motherSessionId: 'M',
    featureId,
    task: `task ${sid}`,
    composedPrompt: 'p',
  })
  return store.markRunning(h.id, sid)
}

function surfaces(lives: Array<{ id: string; status: LiveStatus }>) {
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
  const live = rows.map((r) => toAttentionLive(r, states.get(r.id)!, null, null))
  const handoffs = store.list()
  const items = projectAttention({
    handoffs,
    transitions: readTransitions(testDb, handoffs),
    live,
    ...readRequestInput(),
  })
  const infos = live.map((s) => harness.toLiveInfo(testDb, s))
  const graph = buildSessionGraph({ ...readSessionGraphInput(testDb, states), attention: items })
  const inUse = new Set(graph.nodes.filter((n) => n.status !== 'ended').map((n) => n.sessionId))
  const entries = buildSwitcherEntries(
    graph,
    new Map(infos.map((i) => [i.id, i])),
    () => null,
    inUse,
    items,
  )

  const room = (featureId: string) => {
    const lane = graph.lanes.find((l) => l.kind === 'feature' && l.featureId === featureId)
    const laneSessionIds = new Set(
      (lane?.repos ?? []).flatMap((r) => r.sessionIds).filter((id) => inUse.has(id)),
    )
    return itemsForFeature(humanQueue(items), laneSessionIds, inUse, featureId)
  }
  const card = (featureId: string) =>
    entries.find((e) => e.kind === 'feature' && e.featureId === featureId)?.needsYou

  return { items, room, card }
}

describe('itemsForFeature == needsYou do card da feature no Ctrl+`', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    harness.applyAllMigrations(testDb)
    harness.seedRepos(testDb)
    harness.seedFeature(testDb, F)
    harness.seedFeature(testDb, G)
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    harness.seedSession(testDb, 'MG', { repoId: 'r5', featureId: G })
    transcriptPath = null
  })
  afterEach(() => testDb.close())

  it('item cuja sessão o mapa desenha em OUTRA lane não conta para a feature do handoff', () => {
    // Handoff da feature F, mas a sessão da filha está na lane de G.
    store.ask(child('r1', 'A', F, G).id, 'qual branch?')
    store.ask(child('r2', 'B', F).id, 'posso apagar?')
    const s = surfaces([
      { id: 'M', status: 'idle' },
      { id: 'MG', status: 'idle' },
      { id: 'A', status: 'working' },
      { id: 'B', status: 'working' },
    ])
    expect(s.items.filter((i) => i.kind === 'request')).toHaveLength(2)
    expect(countAttentionSubjects(s.room(F))).toBe(1)
    expect(countAttentionSubjects(s.room(F))).toBe(s.card(F))
    expect(countAttentionSubjects(s.room(G))).toBe(1)
    expect(countAttentionSubjects(s.room(G))).toBe(s.card(G))
  })

  it('humanQueue inclui request (kind produzido) e isAskItem o reconhece', () => {
    store.ask(child('r1', 'A', F).id, {
      kind: 'decision',
      question: 'A ou B?',
      options: [
        { key: 'A', label: 'a' },
        { key: 'B', label: 'b' },
      ],
    })
    const s = surfaces([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
    ])
    const q = humanQueue(s.items)
    expect(q.map((i) => i.kind)).toEqual(['request'])
    expect(q.every(isAskItem)).toBe(true)
    expect(countAttentionSubjects(s.room(F))).toBe(s.card(F))
  })

  it('filha interrompida sem nó vivo conta pela feature', () => {
    const e = child('r3', 'E', F)
    store.failIfRunning(e.id, 'PTY morreu')
    transcriptPath = '/tmp/e.jsonl'
    const s = surfaces([
      { id: 'M', status: 'idle' },
      { id: 'MG', status: 'idle' },
    ])
    expect(s.items.some((i) => i.kind === 'child_interrupted' && i.sessionId === 'E')).toBe(true)
    expect(countAttentionSubjects(s.room(F))).toBe(1)
    expect(countAttentionSubjects(s.room(F))).toBe(s.card(F))
    expect(countAttentionSubjects(s.room(G))).toBe(0)
  })

  it('result_unconsumed (info) fica fora do recorte', () => {
    const d = child('r4', 'D', F)
    store.report(d.id, 'feito')
    const s = surfaces([
      { id: 'M', status: 'idle' },
      { id: 'MG', status: 'idle' },
      { id: 'D', status: 'idle' },
    ])
    expect(s.items.some((i) => i.kind === 'result_unconsumed')).toBe(true)
    expect(s.room(F)).toEqual([])
    expect(s.card(F)).toBe(0)
  })
})
