import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'
import { up as up036 } from './036_handoff_dismissed'

// Aplica 001-035 (igual ao runner real, respeitando disableForeignKeys) p/
// deixar o schema pronto ANTES da 036.
function applyUpTo035(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 36)) {
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
}

describe('migration 036_handoff_dismissed', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyUpTo035(db)
    db.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)`).run(
      Date.now(),
      Date.now(),
    )
    db.prepare(
      `INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES ('r1','p1','r1','/tmp/r1',0,?)`,
    ).run(Date.now())
  })

  afterEach(() => {
    db.close()
  })

  it('adiciona dismissed_at nullable (linha antiga herda NULL)', () => {
    const now = Date.now()
    db.prepare(
      `INSERT INTO handoffs (id, target_repo_id, task, composed_prompt, status, created_at, updated_at)
       VALUES ('h1','r1','t','p','running',?,?)`,
    ).run(now, now)

    up036(db)

    const names = (db.prepare(`PRAGMA table_info(handoffs)`).all() as ColumnInfo[]).map((c) => c.name)
    expect(names).toContain('dismissed_at')

    const row = db.prepare('SELECT dismissed_at FROM handoffs WHERE id = ?').get('h1') as {
      dismissed_at: number | null
    }
    expect(row.dismissed_at).toBeNull()
  })

  it('aceita o carimbo sem tocar no status (dispensa não é desfecho)', () => {
    const now = Date.now()
    db.prepare(
      `INSERT INTO handoffs (id, target_repo_id, task, composed_prompt, status, created_at, updated_at)
       VALUES ('h2','r1','t','p','running',?,?)`,
    ).run(now, now)
    up036(db)

    db.prepare('UPDATE handoffs SET dismissed_at = ? WHERE id = ?').run(now, 'h2')

    const row = db.prepare('SELECT status, dismissed_at FROM handoffs WHERE id = ?').get('h2') as {
      status: string
      dismissed_at: number | null
    }
    expect(row.dismissed_at).toBe(now)
    expect(row.status).toBe('running')
  })
})
