import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations, runMigrations } from './index'
import { up as up070 } from './070_handoff_ended_by_user'

function applyUpTo069(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 70)) {
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

function handoffColumns(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(handoffs)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  )
}

describe('migration 070_handoff_ended_by_user', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
  })

  afterEach(() => {
    db.close()
  })

  it('is registered as version 70', () => {
    expect(migrations.find((m) => m.version === 70)?.name).toBe('070_handoff_ended_by_user')
  })

  it('adds the column as NULL on handoffs that already exist', () => {
    applyUpTo069(db)
    const now = Date.now()
    db.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)`,
    ).run(now, now)
    db.prepare(
      `INSERT INTO repos (id, project_id, label, path, position, created_at)
       VALUES ('r1','p1','Repo 1','/tmp/r1',0,?)`,
    ).run(now)
    db.prepare(
      `INSERT INTO handoffs (id, target_repo_id, task, composed_prompt, status, created_at, updated_at)
       VALUES ('h1','r1','t','p','done',?,?)`,
    ).run(now, now)
    expect(handoffColumns(db)).not.toContain('ended_by_user_at')

    up070(db)

    expect(handoffColumns(db)).toContain('ended_by_user_at')
    expect(
      db.prepare('SELECT ended_by_user_at AS at FROM handoffs WHERE id = ?').get('h1'),
    ).toEqual({
      at: null,
    })
  })

  it('a fresh database ends with the column', () => {
    runMigrations(db)
    expect(handoffColumns(db)).toContain('ended_by_user_at')
  })
})
