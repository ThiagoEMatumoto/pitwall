import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'
import { up as up050 } from './050_sessions_provider'

function applyUpTo049(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 50)) {
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

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
}

function column(db: Database.Database, name: string): ColumnInfo | undefined {
  const rows = db.pragma('table_info(sessions)') as ColumnInfo[]
  return rows.find((r) => r.name === name)
}

describe('migration 050_sessions_provider', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyUpTo049(db)
  })

  afterEach(() => {
    db.close()
  })

  it('is registered as migration 50', () => {
    const entry = migrations.find((m) => m.version === 50)
    expect(entry?.name).toBe('050_sessions_provider')
  })

  it("adds provider NOT NULL DEFAULT 'claude' and a nullable launch_json", () => {
    up050(db)
    expect(column(db, 'provider')).toMatchObject({
      type: 'TEXT',
      notnull: 1,
      dflt_value: "'claude'",
    })
    expect(column(db, 'launch_json')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
  })

  it('existing sessions become claude with launch_json null', () => {
    db.prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at)
       VALUES ('s1', NULL, 'cc-1', 'exited', 1)`,
    ).run()
    up050(db)
    expect(db.prepare(`SELECT provider, launch_json FROM sessions WHERE id = 's1'`).get()).toEqual({
      provider: 'claude',
      launch_json: null,
    })
  })

  // Mesmo statement do startSession (ipc/sessions.ts): prova que o INSERT real
  // cabe no schema migrado.
  it('accepts the INSERT used by startSession', () => {
    up050(db)
    db.prepare(
      `INSERT INTO sessions
       (id, repo_id, cc_session_id, title, pane_id, status, started_at, ended_at, feature_id, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('s2', null, 'cc-2', null, null, 'running', 2, null, null, 'claude')
    expect(db.prepare(`SELECT provider FROM sessions WHERE id = 's2'`).get()).toEqual({
      provider: 'claude',
    })
  })
})
