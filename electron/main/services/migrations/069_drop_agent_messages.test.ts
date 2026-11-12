import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations, runMigrations } from './index'
import { up as up069 } from './069_drop_agent_messages'

function applyUpTo068(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 69)) {
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

function schemaNames(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%agent_messages%'`)
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

describe('migration 069_drop_agent_messages', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
  })

  afterEach(() => {
    db.close()
  })

  it('is registered as version 69 and keeps 052 in the chain', () => {
    expect(migrations.find((m) => m.version === 69)?.name).toBe('069_drop_agent_messages')
    expect(migrations.find((m) => m.version === 52)?.name).toBe('052_agent_messages')
  })

  it('drops the table and its indexes, with rows in it', () => {
    applyUpTo068(db)
    // Mesmo INSERT que o AgentBus fazia (052_agent_messages.test.ts).
    db.prepare(
      `INSERT INTO agent_messages
         (id, from_session_id, to_session_id, to_repo_id, feature_id, depth, text, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run('a1', 's-from', 's-to', 'r1', null, 1, 'como está o contrato?', 10, 20)
    expect(schemaNames(db)).toEqual(
      expect.arrayContaining([
        'agent_messages',
        'idx_agent_messages_pair',
        'idx_agent_messages_to',
      ]),
    )

    up069(db)

    expect(schemaNames(db)).toEqual([])
  })

  it('a fresh database ends without the table', () => {
    runMigrations(db)
    expect(schemaNames(db)).toEqual([])
  })

  it('is idempotent on a database that never had the table', () => {
    expect(() => up069(db)).not.toThrow()
  })
})
