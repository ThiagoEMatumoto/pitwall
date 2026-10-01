import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'
import { up as up052 } from './052_agent_messages'

function applyUpTo051(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 52)) {
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
  notnull: number
  pk: number
}

describe('migration 052_agent_messages', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyUpTo051(db)
  })

  afterEach(() => {
    db.close()
  })

  it('is registered as the last migration, version 52', () => {
    const entry = migrations.find((m) => m.version === 52)
    expect(entry?.name).toBe('052_agent_messages')
    expect(Math.max(...migrations.map((m) => m.version))).toBe(52)
  })

  it('creates agent_messages with the ask/reply columns', () => {
    up052(db)
    const cols = db.pragma('table_info(agent_messages)') as ColumnInfo[]
    expect(cols.map((c) => c.name)).toEqual([
      'id',
      'from_session_id',
      'to_session_id',
      'to_repo_id',
      'feature_id',
      'depth',
      'text',
      'reply',
      'status',
      'created_at',
      'delivered_at',
      'answered_at',
      'expires_at',
    ])
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['id'])
    const nullable = cols.filter((c) => c.notnull === 0).map((c) => c.name)
    expect(nullable).toEqual(
      expect.arrayContaining(['to_session_id', 'to_repo_id', 'feature_id', 'reply']),
    )
  })

  // Mesmo INSERT do AgentBus.ask: o ask novo cabe no schema migrado.
  it('accepts the INSERT used by the agent bus and defaults reply to null', () => {
    up052(db)
    db.prepare(
      `INSERT INTO agent_messages
         (id, from_session_id, to_session_id, to_repo_id, feature_id, depth, text, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run('a1', 's-from', 's-to', 'r1', null, 1, 'como está o contrato?', 10, 20)
    expect(
      db.prepare(`SELECT reply, status, delivered_at, answered_at FROM agent_messages`).get(),
    ).toEqual({ reply: null, status: 'pending', delivered_at: null, answered_at: null })
  })
})
