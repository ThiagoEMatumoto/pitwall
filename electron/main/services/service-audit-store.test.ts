import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations, runMigrations } from './migrations/index'

// Mesmo padrão de repo-pull-store.test: getDb mockado pra SQLite in-memory.
let testDb: Database.Database
vi.mock('./db', () => ({
  getDb: () => testDb,
}))

import { lastServiceCall, listServiceCalls, recordServiceCall } from './service-audit-store'

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

describe('service-audit-store', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    testDb.close()
  })

  it('insere e lê de volta uma chamada ok', () => {
    const entry = recordServiceCall({
      sessionId: 's-1',
      service: 'litellm',
      operation: 'chat_completions',
      status: 'ok',
      durationMs: 412.6,
    })

    expect(entry.durationMs).toBe(413)
    expect(entry.error).toBeNull()
    expect(listServiceCalls()).toEqual([entry])
  })

  it('aceita sessão anônima (session_id null) e erro redigido', () => {
    const entry = recordServiceCall({
      sessionId: null,
      service: 'gemini',
      operation: 'generate_content',
      status: 'error',
      durationMs: 90,
      error: 'HTTP 401: [REDACTED]',
    })

    expect(listServiceCalls()[0]).toEqual(entry)
    expect(entry.sessionId).toBeNull()
  })

  it('lista mais recente primeiro, filtra por serviço e respeita limit', () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(3000)
    recordServiceCall({
      sessionId: null,
      service: 'litellm',
      operation: 'a',
      status: 'ok',
      durationMs: 1,
    })
    recordServiceCall({
      sessionId: null,
      service: 'gemini',
      operation: 'b',
      status: 'ok',
      durationMs: 2,
    })
    recordServiceCall({
      sessionId: null,
      service: 'litellm',
      operation: 'c',
      status: 'error',
      durationMs: 3,
      error: 'boom',
    })

    expect(listServiceCalls().map((e) => e.operation)).toEqual(['c', 'b', 'a'])
    expect(listServiceCalls({ service: 'litellm' }).map((e) => e.operation)).toEqual(['c', 'a'])
    expect(listServiceCalls({ limit: 1 }).map((e) => e.operation)).toEqual(['c'])
  })

  it('lastServiceCall devolve a última do serviço ou null', () => {
    expect(lastServiceCall('litellm')).toBeNull()
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000)
    recordServiceCall({
      sessionId: null,
      service: 'litellm',
      operation: 'first',
      status: 'ok',
      durationMs: 1,
    })
    const last = recordServiceCall({
      sessionId: null,
      service: 'litellm',
      operation: 'second',
      status: 'ok',
      durationMs: 1,
    })

    expect(lastServiceCall('litellm')).toEqual(last)
    expect(lastServiceCall('tavily')).toBeNull()
  })

  it('runMigrations num banco novo aplica diagram_library (39) E service_proxy_calls (40)', () => {
    // Regressão da colisão de version 39 entre as duas features após o rebase.
    const db = new Database(':memory:')
    runMigrations(db)
    const versions = (
      db.prepare('SELECT version FROM _migrations ORDER BY version').all() as Array<{
        version: number
      }>
    ).map((r) => r.version)
    expect(versions).toContain(39)
    expect(versions).toContain(40)
    expect(new Set(versions).size).toBe(versions.length)
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE name IN ('diagram_library_items', 'service_proxy_calls') ORDER BY name`,
      )
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toEqual(['diagram_library_items', 'service_proxy_calls'])
    db.close()
  })
})
