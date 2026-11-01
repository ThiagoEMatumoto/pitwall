import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// "Filha de quem" por CONVERSA em todas as superfícies. Banco migrado, handoffStore
// real e buildSessionGraph/readSessionGraphInput: o shape é o que o main produz.
let testDb: Database.Database
vi.mock('./db', () => ({ getDb: () => testDb }))
vi.mock('./transcript-path', () => ({ findTranscriptPath: () => null }))

import * as handoffStore from './handoff-store'
import { applyAllMigrations, seedFeature, seedRepos, seedSession } from './attention/attention-test-harness'
import { buildSessionGraph, readSessionGraphInput, type LiveSessionState } from './session-graph'
import { allMothers, childIdsByMother } from '../../../src/features/feature-room/all-mothers-model'
import { motherOfFocus } from '../../../src/features/session-canvas/mother-dock'
import { motherOfChildMap } from '../../../src/features/sessions/conversation-hierarchy'
import { orderByFeature } from '../../../src/features/session-switcher/order-by-feature'

function ccOf(id: string): string {
  return (testDb.prepare('SELECT cc_session_id FROM sessions WHERE id = ?').get(id) as {
    cc_session_id: string
  }).cc_session_id
}

// O resume abre uma linha NOVA com o mesmo cc_session_id (ipc/sessions.ts).
function resumeRow(fromId: string, newId: string): void {
  const row = testDb.prepare('SELECT repo_id, feature_id FROM sessions WHERE id = ?').get(fromId) as {
    repo_id: string
    feature_id: string | null
  }
  testDb
    .prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at, feature_id)
       VALUES (?, ?, ?, 'running', ?, ?)`,
    )
    .run(newId, row.repo_id, ccOf(fromId), Date.now() + 1000, row.feature_id)
}

function dispatchDone(motherId: string, childId: string, repoId: string): string {
  const h = handoffStore.create({
    motherSessionId: motherId,
    targetRepoId: repoId,
    task: `task ${childId}`,
    composedPrompt: 'p',
  })
  handoffStore.markRunning(h.id, childId)
  handoffStore.report(h.id, 'feito')
  return h.id
}

function produce(liveIds: string[]) {
  const live = new Map<string, LiveSessionState>(
    liveIds.map((id) => [id, { status: 'idle', lastActivityAt: 1, name: null }]),
  )
  const graph = buildSessionGraph(readSessionGraphInput(testDb, live))
  const inUse = new Set(liveIds)
  return { graph, inUse }
}

function stripOrder(graph: ReturnType<typeof produce>['graph'], ids: string[]): string[] {
  const featureOf = new Map(graph.nodes.map((n) => [n.sessionId, n.featureId ?? null]))
  return orderByFeature(
    ids.map((id) => ({ id })),
    featureOf,
    motherOfChildMap(graph.nodes),
  ).items.map((s) => s.id)
}

describe('hierarquia por conversa (classes A/B/C)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    seedRepos(testDb)
    seedFeature(testDb, 'F1')
    seedSession(testDb, 'mae', { repoId: 'r1', featureId: 'F1' })
    seedSession(testDb, 'avulsa', { repoId: 'r3', featureId: 'F1' })
    seedSession(testDb, 'filha', { repoId: 'r2', featureId: 'F1' })
  })
  afterEach(() => testDb.close())

  function expectChildOfMother(liveIds: string[], mother: string, child: string) {
    const { graph, inUse } = produce(liveIds)
    expect(graph.nodes.find((n) => n.sessionId === child)?.hierarchyMotherId).toBe(mother)
    expect(
      graph.edges.some((e) => e.kind === 'handoff' && e.from === mother && e.to === child),
    ).toBe(true)
    expect(allMothers(graph.nodes, graph.edges, inUse).map((n) => n.sessionId)).not.toContain(
      child,
    )
    expect(childIdsByMother(graph.edges, inUse).get(mother)?.has(child)).toBe(true)
    // Filha done/dispensada não tira a mãe do Dock nem do Ctrl+Shift+O.
    expect(motherOfFocus(graph.nodes, graph.edges, inUse, { sessionId: child })).toBe(mother)
    const order = stripOrder(graph, [child, 'avulsa', mother])
    expect(order.indexOf(child)).toBe(order.indexOf(mother) + 1)
  }

  it('A: filha com handoff done continua sob a mãe', () => {
    dispatchDone('mae', 'filha', 'r2')
    expectChildOfMother(['mae', 'filha', 'avulsa'], 'mae', 'filha')
  })

  it('A: filha com handoff done E dispensado continua sob a mãe', () => {
    const h = dispatchDone('mae', 'filha', 'r2')
    handoffStore.dismiss(h)
    expectChildOfMother(['mae', 'filha', 'avulsa'], 'mae', 'filha')
  })

  it('B: filha retomada (linha nova, mesmo cc) continua sob a mãe', () => {
    dispatchDone('mae', 'filha', 'r2')
    resumeRow('filha', 'filha-2')
    expectChildOfMother(['mae', 'filha-2', 'avulsa'], 'mae', 'filha-2')
  })

  it('C: mãe retomada com handoff terminal segue ligada à filha viva', () => {
    dispatchDone('mae', 'filha', 'r2')
    resumeRow('mae', 'mae-2')
    expectChildOfMother(['mae-2', 'filha', 'avulsa'], 'mae-2', 'filha')
  })

  it('B+C após reinício do app: as duas retomadas, ainda mãe e filha', () => {
    dispatchDone('mae', 'filha', 'r2')
    resumeRow('mae', 'mae-2')
    resumeRow('filha', 'filha-2')
    expectChildOfMother(['mae-2', 'filha-2', 'avulsa'], 'mae-2', 'filha-2')
  })

  it('só o Desvincular (release) solta a filha', () => {
    dispatchDone('mae', 'filha', 'r2')
    resumeRow('filha', 'filha-2')
    const h = handoffStore.getByChildConversation('filha-2')!
    handoffStore.release(h.id)
    const { graph, inUse } = produce(['mae', 'filha-2', 'avulsa'])
    expect(graph.nodes.find((n) => n.sessionId === 'filha-2')?.hierarchyMotherId).toBeNull()
    expect(graph.edges.some((e) => e.kind === 'handoff' && e.to === 'filha-2')).toBe(false)
    expect(allMothers(graph.nodes, graph.edges, inUse).map((n) => n.sessionId)).toContain(
      'filha-2',
    )
  })

  it('resume religa child_session_id (terminal) e a liderança terminal para a linha nova', () => {
    const h = dispatchDone('mae', 'filha', 'r2')
    resumeRow('filha', 'filha-2')
    resumeRow('mae', 'mae-2')
    const touchedChild = handoffStore.adoptResumedConversation(['filha'], 'filha-2')
    const touchedMother = handoffStore.adoptResumedConversation(['mae'], 'mae-2')
    expect(touchedChild).toEqual([h])
    expect(touchedMother).toEqual([h])
    const row = handoffStore.get(h)!
    expect(row.childSessionId).toBe('filha-2')
    expect(row.motherSessionId).toBe('mae-2')
    expect(row.status).toBe('done')
    const { graph } = produce(['mae-2', 'filha-2'])
    expect(graph.nodes.find((n) => n.sessionId === 'filha-2')?.childOfHandoffId).toBe(h)
  })

  it('resume não religa handoff solto (release) nem rouba filha viva', () => {
    const h = dispatchDone('mae', 'filha', 'r2')
    handoffStore.release(h)
    resumeRow('filha', 'filha-2')
    expect(handoffStore.adoptResumedConversation(['filha'], 'filha-2')).toEqual([])
    expect(handoffStore.get(h)!.childSessionId).toBeNull()

    seedSession(testDb, 'viva', { repoId: 'r4', featureId: 'F1' })
    const live = handoffStore.create({
      motherSessionId: 'mae',
      targetRepoId: 'r4',
      task: 't',
      composedPrompt: 'p',
    })
    handoffStore.markRunning(live.id, 'viva')
    handoffStore.adoptResumedConversation(['viva'], 'outra')
    expect(handoffStore.get(live.id)!.childSessionId).toBe('viva')
  })
})
