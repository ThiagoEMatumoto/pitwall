import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './migrations/index'
import type { PullRepoResult } from '../../../shared/types/ipc'

// Mesmo padrão de scheduled-job-store.test: o store importa getDb de './db' (que
// depende de electron.app); mockamos pra um SQLite in-memory migrado.
let testDb: Database.Database
vi.mock('./db', () => ({
  getDb: () => testDb,
}))

import { getLastPullRun, recordPullRun } from './repo-pull-store'

function applyAllMigrations(db: Database.Database): void {
  for (const m of migrations) {
    if (m.disableForeignKeys) {
      db.pragma('foreign_keys = OFF')
      try {
        m.up(db)
      } finally {
        db.pragma('foreign_keys = ON')
      }
    } else {
      m.up(db)
    }
  }
}

function result(overrides: Partial<PullRepoResult> = {}): PullRepoResult {
  return { repoId: 'r1', label: 'Repo 1', path: '/tmp/r1', status: 'skipped', ...overrides }
}

describe('getLastPullRun', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('null quando não há nenhuma run', () => {
    expect(getLastPullRun()).toBeNull()
  })

  it('propaga behind e reason da branch mais atrasada', () => {
    recordPullRun({
      trigger: 'auto',
      startedAt: 1,
      finishedAt: 2,
      results: [
        result({
          branches: [
            { branch: 'feat/x', status: 'up-to-date', behind: 0 },
            { branch: 'main', status: 'skipped', detail: 'checked-out-elsewhere', behind: 119 },
          ],
        }),
      ],
    })

    expect(getLastPullRun()?.repos[0]).toEqual({
      repoId: 'r1',
      status: 'skipped',
      behind: 119,
      reason: 'checked-out-elsewhere',
    })
  })

  it('branch sem detail deixa reason ausente', () => {
    recordPullRun({
      trigger: 'manual',
      startedAt: 1,
      finishedAt: 2,
      results: [result({ status: 'pulled', branches: [{ branch: 'main', status: 'pulled', behind: 0 }] })],
    })

    const repo = getLastPullRun()?.repos[0]
    expect(repo?.behind).toBe(0)
    expect(repo?.reason).toBeUndefined()
  })

  it('ignora branches sem behind medido (ex.: fetch falhou)', () => {
    recordPullRun({
      trigger: 'auto',
      startedAt: 1,
      finishedAt: 2,
      results: [
        result({
          status: 'error',
          branches: [{ branch: 'origin', status: 'error', detail: 'boom' }],
        }),
      ],
    })

    const repo = getLastPullRun()?.repos[0]
    expect(repo?.behind).toBeUndefined()
    expect(repo?.reason).toBeUndefined()
  })
})
