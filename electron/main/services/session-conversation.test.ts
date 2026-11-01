import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './migrations/index'
import { currentSessionIds } from './session-conversation'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  for (const m of migrations) m.up(db)
  const insert = db.prepare(
    `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, 'r1', ?, 'exited', ?)`,
  )
  insert.run('s-old', 'cc-1', 1)
  insert.run('s-mid', 'cc-1', 2)
  insert.run('s-new', 'cc-1', 3)
  insert.run('s-solo', null, 4)
})
afterEach(() => db.close())

describe('currentSessionIds', () => {
  it('troca o id antigo pela linha mais recente da conversa, sem repetir', () => {
    expect(currentSessionIds(db, ['s-old', 's-mid', 's-solo', 's-ghost'])).toEqual([
      's-new',
      's-solo',
      's-ghost',
    ])
  })
})
