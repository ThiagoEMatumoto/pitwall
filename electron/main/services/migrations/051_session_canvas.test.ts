import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'
import { up as up051 } from './051_session_canvas'

function applyUpTo050(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 51)) {
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
  pk: number
}

function columns(db: Database.Database, table: string): ColumnInfo[] {
  return db.pragma(`table_info(${table})`) as ColumnInfo[]
}

describe('migration 051_session_canvas', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyUpTo050(db)
  })

  afterEach(() => {
    db.close()
  })

  it('is registered as the last migration, version 51', () => {
    const entry = migrations.find((m) => m.version === 51)
    expect(entry?.name).toBe('051_session_canvas')
    expect(Math.max(...migrations.map((m) => m.version))).toBe(51)
  })

  it('creates canvas_positions keyed by (scope, kind, entity_id)', () => {
    up051(db)
    const cols = columns(db, 'canvas_positions')
    expect(cols.map((c) => c.name)).toEqual([
      'scope',
      'kind',
      'entity_id',
      'x',
      'y',
      'w',
      'h',
      'view_state',
    ])
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['scope', 'kind', 'entity_id'])
    const insert = db.prepare(
      `INSERT INTO canvas_positions (scope, kind, entity_id, x, y) VALUES ('all', 'session', 's1', 1, 2)`,
    )
    insert.run()
    expect(() => insert.run()).toThrow(/UNIQUE/)
  })

  // Cartão nunca arrastado guarda só o estado de exibição: sem x/y, o layout segue automático.
  it('accepts a view_state-only row (x/y null) for a session card', () => {
    up051(db)
    db.prepare(
      `INSERT INTO canvas_positions (scope, kind, entity_id, view_state) VALUES ('all', 'session', 's1', 'collapsed')`,
    ).run()
    expect(
      db.prepare(`SELECT x, y, view_state FROM canvas_positions WHERE entity_id = 's1'`).get(),
    ).toEqual({ x: null, y: null, view_state: 'collapsed' })
  })

  it('creates canvas_notes and session_groups', () => {
    up051(db)
    expect(columns(db, 'canvas_notes').map((c) => c.name)).toEqual([
      'id',
      'scope',
      'body_md',
      'attached_session_id',
      'color',
      'created_at',
      'updated_at',
    ])
    expect(columns(db, 'session_groups').map((c) => c.name)).toEqual([
      'id',
      'scope',
      'name',
      'color',
      'created_at',
    ])
  })

  it('adds purpose, group_id and last_summary(_at) to sessions; existing rows stay null', () => {
    db.prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at)
       VALUES ('s1', NULL, 'cc-1', 'exited', 1)`,
    ).run()
    up051(db)
    const names = columns(db, 'sessions').map((c) => c.name)
    expect(names).toEqual(
      expect.arrayContaining(['purpose', 'group_id', 'last_summary', 'last_summary_at']),
    )
    expect(
      db
        .prepare(
          `SELECT purpose, group_id, last_summary, last_summary_at FROM sessions WHERE id = 's1'`,
        )
        .get(),
    ).toEqual({ purpose: null, group_id: null, last_summary: null, last_summary_at: null })
  })

  // Mesmo INSERT do startSession (ipc/sessions.ts): a sessão nova cabe no schema migrado.
  it('accepts the INSERT used by startSession', () => {
    up051(db)
    db.prepare(
      `INSERT INTO sessions
       (id, repo_id, cc_session_id, title, pane_id, status, started_at, ended_at, feature_id, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('s2', null, 'cc-2', null, null, 'running', 2, null, null, 'claude')
    expect(db.prepare(`SELECT purpose FROM sessions WHERE id = 's2'`).get()).toEqual({
      purpose: null,
    })
  })
})
