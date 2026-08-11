import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './migrations/index'

// Mesmo padrão dos demais store tests: mock de ./db pra um SQLite in-memory.
let testDb: Database.Database
vi.mock('./db', () => ({
  getDb: () => testDb,
}))

import { getPref, setPref } from './prefs-store'

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

describe('prefs-store', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('getPref retorna o fallback quando a key não existe', () => {
    expect(getPref('handoffs.heartbeatTtlHours', 5)).toBe(5)
  })

  it('setPref + getPref round-trip preserva o valor (number)', () => {
    setPref('handoffs.heartbeatTtlHours', 8)
    expect(getPref('handoffs.heartbeatTtlHours', 5)).toBe(8)
  })

  it('getPref retorna o fallback quando o JSON armazenado é inválido', () => {
    testDb
      .prepare('INSERT OR REPLACE INTO app_prefs (key, value) VALUES (?, ?)')
      .run('handoffs.heartbeatTtlHours', 'not-json{')
    expect(getPref('handoffs.heartbeatTtlHours', 5)).toBe(5)
  })
})
