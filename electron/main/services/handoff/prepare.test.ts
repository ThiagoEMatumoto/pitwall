/** @vitest-environment node */
// prepareHandoff é o caminho comum de create-manual e adoção. A posse do repo-alvo
// é decidida dentro do store.create (migration 054): aqui se trava que esse
// caminho também é recusado — antes dele só o MCP tinha dedup.
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../migrations/index'

let testDb: Database.Database
vi.mock('../db', () => ({ getDb: () => testDb }))
vi.mock('../notify', () => ({ broadcast: vi.fn() }))
vi.mock('../transcript-path', () => ({ findTranscriptPath: () => null }))

import { prepareHandoff } from './prepare'
import { HandoffDuplicateError } from '../handoff-store'

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

beforeEach(() => {
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  applyAllMigrations(testDb)
  const now = Date.now()
  testDb
    .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)`)
    .run(now, now)
  testDb
    .prepare(
      `INSERT INTO repos (id, project_id, label, path, position, created_at)
       VALUES ('r1','p1','Repo 1','/tmp/r1',0,?)`,
    )
    .run(now)
})

afterEach(() => testDb.close())

describe('prepareHandoff — posse do repo-alvo', () => {
  it('segundo prepare no mesmo repo é recusado com HandoffDuplicateError', () => {
    const first = prepareHandoff({ targetRepoId: 'r1', motherSessionId: 'm-a', task: 'A' })
    expect(first.handoff.status).toBe('approved')

    let err: unknown
    try {
      prepareHandoff({ targetRepoId: 'r1', motherSessionId: 'm-b', task: 'B' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(HandoffDuplicateError)
    expect((err as HandoffDuplicateError).code).toBe('HANDOFF_DUPLICATE')
    expect((err as HandoffDuplicateError).existing.id).toBe(first.handoff.id)
    const n = testDb.prepare('SELECT COUNT(*) AS n FROM handoffs').get() as { n: number }
    expect(n.n).toBe(1)
  })

  it('forceReason substitui o ativo e grava o motivo', () => {
    const first = prepareHandoff({ targetRepoId: 'r1', motherSessionId: 'm-a', task: 'A' })
    const second = prepareHandoff({
      targetRepoId: 'r1',
      motherSessionId: 'm-a',
      task: 'B',
      forceReason: 'refazer do zero',
    })
    const old = testDb
      .prepare('SELECT status FROM handoffs WHERE id = ?')
      .get(first.handoff.id) as {
      status: string
    }
    expect(old.status).toBe('interrupted')
    expect(second.handoff.status).toBe('approved')
    const ev = testDb
      .prepare("SELECT detail FROM handoff_events WHERE handoff_id = ? AND event = 'force'")
      .get(second.handoff.id) as { detail: string }
    expect(JSON.parse(ev.detail)).toEqual({
      superseded: first.handoff.id,
      reason: 'refazer do zero',
    })
  })
})
