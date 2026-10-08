import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'

describe('migration 053_sessions_feature_source', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
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
  })

  afterEach(() => {
    db.close()
  })

  it('is registered as version 53', () => {
    expect(migrations.find((m) => m.version === 53)?.name).toBe('053_sessions_feature_source')
  })

  it('adds a nullable sessions.feature_source', () => {
    const cols = db.pragma('table_info(sessions)') as Array<{ name: string; notnull: number }>
    const col = cols.find((c) => c.name === 'feature_source')
    expect(col).toBeDefined()
    expect(col?.notnull).toBe(0)
  })
})
