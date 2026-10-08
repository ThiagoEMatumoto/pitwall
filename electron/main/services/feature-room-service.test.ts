/** @vitest-environment node */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Dados escritos pelos PRODUTORES (handoffStore, setObjectiveLinks, objective-store,
// archive) sobre banco migrado: prova que cada campo da Room tem escritor.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}))
let testDb: Database.Database
vi.mock('./db', () => ({ getDb: () => testDb }))

import {
  applyAllMigrations,
  seedFeature,
  seedRepos,
  seedSession,
} from './attention/attention-test-harness'
import * as handoffs from './handoff-store'
import * as featureStore from './feature-store'
import { create as createObjective, createKeyResult } from './objective-store'
import { wakeHealth } from './handoff/handoff-wake'
import { listFeatureEvents, objectiveChainOf, roomSnapshot } from './feature-room-service'

const T0 = 1_700_000_000_000

function delegate(repo: string, featureId: string, task: string) {
  return handoffs.create({
    targetRepoId: repo,
    motherSessionId: 'M',
    featureId,
    task,
    composedPrompt: 'p',
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  applyAllMigrations(testDb)
  seedRepos(testDb)
  seedFeature(testDb, 'F')
  seedFeature(testDb, 'G')
})
afterEach(() => {
  testDb.close()
  vi.useRealTimers()
})

describe('listFeatureEvents', () => {
  it('só a feature, mais novo primeiro, LIMIT respeitado; outra feature fica fora', () => {
    seedSession(testDb, 'A', { repoId: 'r1', featureId: 'F' })
    const a = delegate('r1', 'F', 'tarefa A')
    vi.setSystemTime(T0 + 500)
    handoffs.markRunning(a.id, 'A')
    vi.setSystemTime(T0 + 1_000)
    handoffs.ask(a.id, 'qual branch?')
    vi.setSystemTime(T0 + 2_000)
    delegate('r2', 'G', 'tarefa G')
    vi.setSystemTime(T0 + 3_000)
    handoffs.fail(a.id, 'quebrou')

    const all = listFeatureEvents(testDb, 'F')
    expect(all.length).toBeGreaterThanOrEqual(4)
    expect(all.every((e) => e.handoffId === a.id && e.task === 'tarefa A')).toBe(true)
    expect(all.map((e) => e.at)).toEqual([...all.map((e) => e.at)].sort((x, y) => y - x))
    expect(all[0]).toMatchObject({
      event: 'fail',
      toStatus: 'failed',
      motherSessionId: 'M',
      childSessionId: 'A',
    })

    const two = listFeatureEvents(testDb, 'F', 2)
    expect(two).toEqual(all.slice(0, 2))
    expect(listFeatureEvents(testDb, 'G').every((e) => e.task === 'tarefa G')).toBe(true)
  })
})

describe('objectiveChainOf', () => {
  it('1 objetivo direto + 1 KR (o KR traz o objetivo dono)', () => {
    const direct = createObjective({ title: 'Reduzir abandono', kind: 'okr' })
    const owner = createObjective({ title: 'Aumentar receita', kind: 'okr' })
    const kr = createKeyResult({ objectiveId: owner.id, title: 'R$7,5k por protocolo' })
    featureStore.setObjectiveLinks('F', [
      { targetType: 'objective', targetId: direct.id },
      { targetType: 'key_result', targetId: kr.id },
    ])
    expect(objectiveChainOf(testDb, 'F')).toEqual([
      {
        objectiveId: owner.id,
        objectiveTitle: 'Aumentar receita',
        krId: kr.id,
        krTitle: 'R$7,5k por protocolo',
      },
      { objectiveId: direct.id, objectiveTitle: 'Reduzir abandono', krId: null, krTitle: null },
    ])
    expect(objectiveChainOf(testDb, 'G')).toEqual([])
  })
})

describe('roomSnapshot', () => {
  it('feature inexistente → null; arquivada → null', () => {
    expect(roomSnapshot('nope', T0)).toBeNull()
    featureStore.archive('G')
    expect(roomSnapshot('G', T0)).toBeNull()
  })

  it('wakeHealth repassado sem alteração (attempted 0 numa feature sem wakes)', () => {
    delegate('r1', 'F', 'tarefa A')
    const snap = roomSnapshot('F', T0)
    expect(snap).not.toBeNull()
    expect(snap!.wakeHealth).toEqual(wakeHealth({ featureId: 'F' }, T0))
    expect(snap!.wakeHealth.attempted).toBe(0)
    expect(snap!.feature.id).toBe('F')
    expect(snap!.timeline.length).toBeGreaterThan(0)
    expect(snap!.loop).toHaveProperty('liveness')
  })
})
