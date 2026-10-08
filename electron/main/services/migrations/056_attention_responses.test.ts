import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrations } from './index'

describe('migration 056_attention_responses', () => {
  it('is registered as version 56 and creates the table', () => {
    expect(migrations.find((m) => m.version === 56)?.name).toBe('056_attention_responses')
    const db = new Database(':memory:')
    for (const m of migrations) {
      if (m.disableForeignKeys) db.pragma('foreign_keys = OFF')
      m.up(db)
      db.pragma('foreign_keys = ON')
    }
    const cols = (db.prepare('PRAGMA table_info(attention_responses)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    expect(cols).toEqual([
      'id',
      'session_id',
      'handoff_id',
      'menu_kind',
      'tool',
      'command_summary',
      'choice',
      'waited_ms',
      'created_at',
    ])
    db.close()
  })
})
