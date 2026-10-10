/** @vitest-environment node */
// A transferência de liderança do sessions:resume contra o produtor real: o
// handoff nasce pelo handoff-store num SQLite com as migrations de verdade, e o
// que se confere é a coluna handoffs.mother_session_id, não um fake do store.
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../services/migrations/index'

let testDb: Database.Database
const live = vi.hoisted(() => new Set<string>())

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cm-test-userdata' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}))
vi.mock('../services/db', () => ({ getDb: () => testDb }))
vi.mock('../services/transcript-path', () => ({ findTranscriptPath: () => null }))
vi.mock('../services/pty-manager', () => ({
  ptyManager: {
    on: () => {},
    off: () => {},
    isRunning: (id: string) => live.has(id),
    runningIds: () => [...live],
  },
}))

import * as handoffStore from '../services/handoff-store'
import { transferLeadershipToResumed } from './sessions'

const CC = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

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

function insertSession(id: string, startedAt: number, status = 'exited'): void {
  testDb
    .prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at)
       VALUES (?, 'r1', ?, ?, ?)`,
    )
    .run(id, CC, status, startedAt)
}

function childOf(mother: string, repoId: string, child: string) {
  testDb
    .prepare(
      `INSERT INTO repos (id, project_id, label, path, position, created_at)
       VALUES (?, 'p1', ?, ?, 0, ?)`,
    )
    .run(repoId, repoId, `/tmp/${repoId}`, Date.now())
  const h = handoffStore.create({
    targetRepoId: repoId,
    task: `tarefa de ${child}`,
    composedPrompt: 'p',
    motherSessionId: mother,
    status: 'approved',
  })
  return handoffStore.markRunning(h.id, child)
}

function motherOf(handoffId: string): string | null {
  const row = testDb
    .prepare('SELECT mother_session_id FROM handoffs WHERE id = ?')
    .get(handoffId) as { mother_session_id: string | null }
  return row.mother_session_id
}

// O mesmo SELECT que o sessions:resume faz antes de subir a PTY nova.
function priorIdsOfCc(): string[] {
  const rows = testDb
    .prepare('SELECT id FROM sessions WHERE cc_session_id = ? ORDER BY started_at DESC')
    .all(CC) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

describe('transferLeadershipToResumed (DB real)', () => {
  beforeEach(() => {
    live.clear()
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    testDb
      .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)`)
      .run(Date.now(), Date.now())
    testDb
      .prepare(
        `INSERT INTO repos (id, project_id, label, path, position, created_at)
         VALUES ('r1','p1','Repo 1','/tmp/r1',0,?)`,
      )
      .run(Date.now())
  })

  afterEach(() => {
    testDb.close()
  })

  it('handoff ativo da linha antiga do cc passa a ter a sessão retomada como mãe', () => {
    insertSession('mother-old', 10)
    const h = childOf('mother-old', 'r-child', 'child-1')
    const prior = priorIdsOfCc()
    insertSession('mother-new', 20, 'running')
    live.add('mother-new')

    transferLeadershipToResumed(prior, 'mother-new')

    expect(motherOf(h.id)).toBe('mother-new')
    expect(handoffStore.get(h.id)?.motherSessionId).toBe('mother-new')
  })

  it('linha antiga com PTY viva mantém a liderança; handoff encerrado também fica', () => {
    insertSession('mother-alive', 5, 'running')
    live.add('mother-alive')
    insertSession('mother-dead', 10)
    const keptAlive = childOf('mother-alive', 'r-a', 'child-a')
    const done = childOf('mother-dead', 'r-b', 'child-b')
    handoffStore.report(done.id, 'feito')
    const moved = childOf('mother-dead', 'r-c', 'child-c')

    transferLeadershipToResumed(priorIdsOfCc(), 'mother-new')

    expect(motherOf(keptAlive.id)).toBe('mother-alive')
    expect(motherOf(done.id)).toBe('mother-dead')
    expect(motherOf(moved.id)).toBe('mother-new')
  })
})
