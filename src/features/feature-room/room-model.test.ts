import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Estado pelo caminho real: handoffStore sobre banco migrado, mapper do main,
// buildSessionGraph e telas capturadas do claude. Nada de AttentionItem à mão,
// exceto o item 'review' (kind sem produtor) que o teste injeta de propósito.
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

const store = await import('../../../electron/main/services/handoff-store')
const { readTransitions, toAttentionLive } =
  await import('../../../electron/main/services/attention/attention-service')
const { buildSessionGraph, readSessionGraphInput } =
  await import('../../../electron/main/services/session-graph')
const harness = await import('../../../electron/main/services/attention/attention-test-harness')
const { listFeatureEvents } = await import('../../../electron/main/services/feature-room-service')
const { projectAttention } = await import('../../../shared/attention/project-attention')
const { countAttentionSubjects, humanQueue, itemsForFeature } =
  await import('../../../shared/attention/selectors')
const { buildRoomView } = await import('./room-model')
const { buildSwitcherEntries } = await import('../session-canvas/feature-switcher-model')

type LiveStatus = import('../../../shared/tui/attention-reason').LiveStatus
type ScreenScan = import('../../../shared/tui/attention-reason').ScreenScan
type LiveSessionState = import('../../../electron/main/services/session-graph').LiveSessionState
type AttentionItem = import('../../../shared/types/attention').AttentionItem

const F = 'F'

interface Live {
  id: string
  status: LiveStatus
  scan?: ScreenScan | null
  lastText?: string
}

function child(repo: string, sid: string, mother = 'M', mode?: 'plan') {
  harness.seedSession(testDb, sid, { repoId: repo, featureId: F })
  const h = store.create({
    targetRepoId: repo,
    motherSessionId: mother,
    featureId: F,
    task: `task ${sid}`,
    composedPrompt: 'p',
    mode,
  })
  return store.markRunning(h.id, sid)
}

function world(
  lives: Live[],
  opts: { timelineFilter?: string | null; extra?: AttentionItem[] } = {},
) {
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
  const byLive = new Map(lives.map((l) => [l.id, l]))
  const live = rows.map((r) => {
    const scan = byLive.get(r.id)?.scan ?? null
    return toAttentionLive(r, states.get(r.id)!, scan, scan?.menu ? 1 : null)
  })
  const handoffs = store.list()
  const attention = [
    ...projectAttention({ handoffs, transitions: readTransitions(testDb, handoffs), live }),
    ...(opts.extra ?? []),
  ]
  const infos = live.map((s) =>
    harness.toLiveInfo(testDb, s, { lastText: byLive.get(s.sessionId)?.lastText ?? null }),
  )
  const graph = buildSessionGraph({ ...readSessionGraphInput(testDb, states), attention })
  const inUse = new Set(graph.nodes.filter((n) => n.status !== 'ended').map((n) => n.sessionId))
  const view = buildRoomView({
    featureId: F,
    graph,
    handoffs,
    live: infos,
    attention,
    inUse,
    timeline: listFeatureEvents(testDb, F),
    timelineFilter: opts.timelineFilter ?? null,
  })
  const lane = graph.lanes.find((l) => l.kind === 'feature' && l.featureId === F)
  const laneIds = new Set(
    (lane?.repos ?? []).flatMap((r) => r.sessionIds).filter((id) => inUse.has(id)),
  )
  const slice = itemsForFeature(humanQueue(attention), laneIds, inUse, F)
  const card = buildSwitcherEntries(graph, new Map(), undefined, inUse, attention).find(
    (e) => e.featureId === F,
  )
  return { view, slice, attention, card }
}

const rowsOf = (v: ReturnType<typeof world>['view']) => v.repos.flatMap((r) => r.rows)

describe('buildRoomView', () => {
  let permission: ScreenScan

  beforeEach(async () => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    harness.applyAllMigrations(testDb)
    harness.seedRepos(testDb)
    harness.seedFeature(testDb, F)
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    transcriptPath = null
    permission = await harness.scanFixture('permission-bash')
  })
  afterEach(() => testDb.close())

  it("readOnly vem do handoff mode 'plan' (só a filha plan; mãe e escritora não)", () => {
    child('r1', 'P', 'M', 'plan')
    child('r2', 'W')
    const { view } = world([
      { id: 'M', status: 'idle' },
      { id: 'P', status: 'working' },
      { id: 'W', status: 'working' },
    ])
    const bySid = new Map(rowsOf(view).map((r) => [r.sessionId, r.readOnly]))
    expect(bySid.get('P')).toBe(true)
    expect(bySid.get('W')).toBe(false)
    expect(view.mother?.readOnly).toBe(false)
  })

  it('needsYou === queue.length === countAttentionSubjects(recorte)', () => {
    store.ask(child('r1', 'A').id, 'qual branch?')
    child('r2', 'B')
    const { view, slice } = world([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
      { id: 'B', status: 'waiting', scan: permission },
    ])
    expect(view.needsYou).toBe(2)
    expect(view.needsYou).toBe(view.queue.length)
    expect(view.needsYou).toBe(countAttentionSubjects(slice))
    expect(view.state).toBe('normal')
    expect(view.progress).toMatchObject({ total: 2, needsYou: 2 })
  })

  it('menu + falha da mesma sessão = 1 linha com also.length === 1', () => {
    const a = child('r1', 'A')
    store.fail(a.id, 'quebrou')
    const { view, attention } = world([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'waiting', scan: permission },
    ])
    const ofA = attention.filter((i) => i.sessionId === 'A' && i.severity !== 'info')
    expect(ofA.map((i) => i.kind).sort()).toEqual(['child_failed', 'session_menu'])
    expect(view.queue).toHaveLength(1)
    expect(view.queue[0].subjectKey).toBe('s:A')
    expect(view.queue[0].also).toHaveLength(1)
  })

  it('neta (depth 2) recuada logo abaixo da filha-mãe dela', () => {
    child('r1', 'A')
    child('r2', 'N', 'A') // neta: a mãe dela é a filha A
    child('r3', 'B')
    const { view } = world([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
      { id: 'N', status: 'working' },
      { id: 'B', status: 'working' },
    ])
    expect(view.mother?.sessionId).toBe('M')
    const rows = rowsOf(view)
    const a = rows.findIndex((r) => r.sessionId === 'A')
    expect(rows[a]).toMatchObject({ depth: 1 })
    expect(rows[a + 1]).toMatchObject({ sessionId: 'N', depth: 2 })
    expect(rows.find((r) => r.sessionId === 'B')).toMatchObject({ depth: 1 })
  })

  it('trabalho e execução independentes: running com PTY morta; pending sem sessão → gone', () => {
    child('r1', 'A')
    child('r2', 'B')
    const p = store.create({
      targetRepoId: 'r3',
      motherSessionId: 'M',
      featureId: F,
      task: 'ainda não subiu',
      composedPrompt: 'p',
    })
    const { view } = world([
      { id: 'M', status: 'idle' },
      { id: 'B', status: 'working', lastText: 'rodando os testes' },
    ])
    const rows = rowsOf(view)
    // O grafo real mantém o nó da PTY morta como 'ended'; o trabalho segue 'running'.
    expect(rows.find((r) => r.sessionId === 'A')).toMatchObject({
      work: { status: 'running' },
      exec: 'ended',
    })
    expect(rows.find((r) => r.handoffId === p.id)).toMatchObject({
      sessionId: null,
      work: { status: 'pending' },
      exec: 'gone',
    })
    expect(rows.find((r) => r.sessionId === 'B')).toMatchObject({
      work: { status: 'running' },
      exec: 'working',
      lastText: 'rodando os testes',
    })
  })

  it('estados: empty → solo → green → normal', () => {
    expect(world([]).view.state).toBe('empty')
    const solo = world([{ id: 'M', status: 'idle' }]).view
    expect(solo.state).toBe('solo')
    expect(solo.mother?.sessionId).toBe('M')
    expect(rowsOf(solo)).toHaveLength(0)
    const a = child('r1', 'A')
    const lives: Live[] = [
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
    ]
    expect(world(lives).view.state).toBe('green')
    store.ask(a.id, 'posso?')
    expect(world(lives).view.state).toBe('normal')
  })

  it('timeline filtrada por sessão (child OU mother)', () => {
    child('r1', 'A')
    child('r2', 'N', 'A')
    child('r3', 'B')
    const lives: Live[] = [
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
      { id: 'N', status: 'working' },
      { id: 'B', status: 'working' },
    ]
    const all = world(lives).view.timeline
    const onlyA = world(lives, { timelineFilter: 'A' }).view.timeline
    expect(onlyA.length).toBeGreaterThan(0)
    expect(onlyA.length).toBeLessThan(all.length)
    expect(onlyA.every((e) => e.childSessionId === 'A' || e.motherSessionId === 'A')).toBe(true)
    // A é a mãe da neta N: os eventos dela entram.
    expect(onlyA.some((e) => e.childSessionId === 'N')).toBe(true)
    expect(onlyA.some((e) => e.childSessionId === 'B')).toBe(false)
  })

  it('texto de tela e de agente chega sem ANSI nem bidi', () => {
    const a = child('r1', 'A')
    store.progress(a.id, 'rm -rf /\u202Etxt.exe')
    const { view } = world([
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working', lastText: '\x1b[31mok\x1b[0m\u202Eabc' },
    ])
    const row = rowsOf(view).find((r) => r.sessionId === 'A')!
    expect(row.lastText).toBe('okabc')
    const ev = view.timeline.find((e) => e.event === 'progress')!
    expect(ev.detail).toBe('rm -rf /txt.exe')
  })

  it('kind fora de PRODUCED_ATTENTION_KINDS: Room e card do Ctrl+` contam igual', () => {
    store.ask(child('r1', 'A').id, 'qual branch?')
    const lives: Live[] = [
      { id: 'M', status: 'idle' },
      { id: 'A', status: 'working' },
    ]
    const real = world(lives).attention.find((i) => i.kind === 'child_question')!
    const review: AttentionItem = {
      ...real,
      kind: 'review',
      dedupKey: 'review:x',
      sessionId: 'M',
      handoffId: null,
    }
    const { view, card } = world(lives, { extra: [review] })
    expect(view.queue.map((r) => r.head.kind)).toEqual(['child_question'])
    expect(view.queue.flatMap((r) => r.also)).toEqual([])
    expect(card?.needsYou).toBe(view.needsYou)
  })
})
