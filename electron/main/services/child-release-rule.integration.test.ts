import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Regra do usuário: "uma filha só pode se soltar da mãe se eu quiser". Só o
// evento 'release' (Desvincular, Trocar mãe, Tornar mãe) solta. Idade, status,
// dispensa do card ou a mãe encerrada não podem tirar a filha de sob a mãe.
// Banco migrado + handoffStore real + readSessionGraphInput: o shape do produtor.
let testDb: Database.Database
vi.mock('./db', () => ({ getDb: () => testDb }))
vi.mock('./transcript-path', () => ({ findTranscriptPath: () => null }))

import * as handoffStore from './handoff-store'
import {
  applyAllMigrations,
  seedFeature,
  seedRepos,
  seedSession,
} from './attention/attention-test-harness'
import { buildSessionGraph, readSessionGraphInput, type LiveSessionState } from './session-graph'
import { motherOfFocus } from '../../../src/features/session-canvas/mother-dock'
import { isMotherLike } from '../../../src/features/sessions/conversation-hierarchy'

const DAY = 24 * 60 * 60 * 1000

function dispatch(motherId: string, childId: string): string {
  const h = handoffStore.create({
    motherSessionId: motherId,
    targetRepoId: 'r2',
    task: `task ${childId}`,
    composedPrompt: 'p',
  })
  handoffStore.markRunning(h.id, childId)
  return h.id
}

function age(handoffId: string, ms: number): void {
  const at = Date.now() - ms
  testDb
    .prepare('UPDATE handoffs SET created_at = ?, updated_at = ? WHERE id = ?')
    .run(at, at, handoffId)
}

function produce(liveIds: string[]) {
  const live = new Map<string, LiveSessionState>(
    liveIds.map((id) => [id, { status: 'idle', lastActivityAt: 1, name: null }]),
  )
  return buildSessionGraph(readSessionGraphInput(testDb, live))
}

function expectUnder(graph: ReturnType<typeof produce>, mother: string, child: string) {
  const ids = graph.nodes.map((n) => n.sessionId)
  expect(ids).toContain(mother)
  expect(ids).toContain(child)
  expect(graph.nodes.find((n) => n.sessionId === child)?.hierarchyMotherId).toBe(mother)
  expect(graph.edges.some((e) => e.kind === 'handoff' && e.from === mother && e.to === child)).toBe(
    true,
  )
}

describe('filha só se solta da mãe pelo release', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    seedRepos(testDb)
    seedFeature(testDb, 'F1')
    seedSession(testDb, 'mae', { repoId: 'r1', featureId: 'F1' })
    seedSession(testDb, 'filha', { repoId: 'r2', featureId: 'F1' })
  })
  afterEach(() => testDb.close())

  it('handoff done há mais de 7 dias: filha encerrada continua sob a mãe viva', () => {
    const h = dispatch('mae', 'filha')
    handoffStore.report(h, 'feito')
    age(h, 8 * DAY)
    expectUnder(produce(['mae']), 'mae', 'filha')
  })

  it('card dispensado: filha encerrada continua sob a mãe viva', () => {
    const h = dispatch('mae', 'filha')
    handoffStore.report(h, 'feito')
    handoffStore.dismiss(h)
    expectUnder(produce(['mae']), 'mae', 'filha')
  })

  it('mãe encerrada com handoff dispensado: filha viva continua sob ela', () => {
    const h = dispatch('mae', 'filha')
    handoffStore.dismiss(h)
    expectUnder(produce(['filha']), 'mae', 'filha')
  })

  it('mãe encerrada com handoff done antigo: filha viva continua sob ela', () => {
    const h = dispatch('mae', 'filha')
    handoffStore.report(h, 'feito')
    age(h, 30 * DAY)
    expectUnder(produce(['filha']), 'mae', 'filha')
  })

  it.each(['failed', 'rejected', 'interrupted'] as const)(
    'status %s não solta a filha viva',
    (status) => {
      const h = dispatch('mae', 'filha')
      testDb.prepare('UPDATE handoffs SET status = ? WHERE id = ?').run(status, h)
      expectUnder(produce(['mae', 'filha']), 'mae', 'filha')
    },
  )

  it('release solta (controle)', () => {
    const h = dispatch('mae', 'filha')
    handoffStore.release(h)
    const graph = produce(['mae', 'filha'])
    expect(graph.nodes.find((n) => n.sessionId === 'filha')?.hierarchyMotherId).toBeNull()
  })

  it('mãe com todas as filhas done/dispensadas ainda é mãe (Dock / Ctrl+Shift+O)', () => {
    const h = dispatch('mae', 'filha')
    handoffStore.report(h, 'feito')
    handoffStore.dismiss(h)
    const graph = produce(['mae', 'filha'])
    const mae = graph.nodes.find((n) => n.sessionId === 'mae')!
    expect(isMotherLike(mae)).toBe(true)
    const inUse = new Set(['mae', 'filha'])
    expect(motherOfFocus(graph.nodes, graph.edges, inUse, {})).toBe('mae')
    expect(motherOfFocus(graph.nodes, graph.edges, inUse, { sessionId: 'filha' })).toBe('mae')
  })
})
