import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'

function apply(db: Database.Database, upTo: number): void {
  for (const m of migrations.filter((x) => x.version <= upTo)) {
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

// Mesmo INSERT do handoffStore.create pré-054 (sem dedup): é assim que as
// duplicatas nasceram em produção (force, prepare e adopt não passavam pelo dedup).
function legacyCreate(
  db: Database.Database,
  id: string,
  repo: string,
  status: string,
  createdAt: number,
  dismissedAt: number | null = null,
): void {
  db.prepare(
    `INSERT INTO handoffs (id, target_repo_id, task, composed_prompt, status, mode, created_at, updated_at, dismissed_at)
     VALUES (?, ?, 't', 'p', ?, 'plan', ?, ?, ?)`,
  ).run(id, repo, status, createdAt, createdAt, dismissedAt)
}

describe('migration 054_handoff_active_target_idx', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    apply(db, 53)
    db.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',1,1)`,
    ).run()
    db.prepare(
      `INSERT INTO repos (id, project_id, label, path, position, created_at)
       VALUES ('r1','p1','R1','/tmp/r1',0,1), ('r2','p1','R2','/tmp/r2',1,1)`,
    ).run()
  })

  afterEach(() => db.close())

  it('is registered as version 54', () => {
    expect(migrations.find((m) => m.version === 54)?.name).toBe('054_handoff_active_target_idx')
  })

  it('saneia duplicatas ativas (fica a mais recente) e só então cria o índice', () => {
    legacyCreate(db, 'old-running', 'r1', 'running', 100)
    legacyCreate(db, 'mid-asking', 'r1', 'needs_input', 200)
    legacyCreate(db, 'newest', 'r1', 'pending', 300)
    legacyCreate(db, 'done', 'r1', 'done', 400)
    legacyCreate(db, 'dismissed', 'r1', 'approved', 500, 500)
    legacyCreate(db, 'alone', 'r2', 'running', 100)

    expect(() => apply54(db)).not.toThrow()

    const status = (id: string) =>
      (db.prepare('SELECT status FROM handoffs WHERE id = ?').get(id) as { status: string }).status
    expect(status('old-running')).toBe('interrupted')
    expect(status('mid-asking')).toBe('interrupted')
    expect(status('newest')).toBe('pending')
    expect(status('done')).toBe('done')
    expect(status('dismissed')).toBe('approved')
    expect(status('alone')).toBe('running')

    const events = db
      .prepare(
        "SELECT handoff_id, from_status FROM handoff_events WHERE event = 'migration_dedup' ORDER BY handoff_id",
      )
      .all()
    expect(events).toEqual([
      { handoff_id: 'mid-asking', from_status: 'needs_input' },
      { handoff_id: 'old-running', from_status: 'running' },
    ])

    expect(() => legacyCreate(db, 'dup', 'r1', 'running', 600)).toThrow(/UNIQUE/)
    // Dispensado e encerrado ficam fora do índice.
    expect(() => legacyCreate(db, 'dup-dismissed', 'r1', 'running', 600, 600)).not.toThrow()
    expect(() => legacyCreate(db, 'r2-done', 'r2', 'done', 600)).not.toThrow()
  })

  it('banco sem duplicatas: aplica sem tocar nada', () => {
    legacyCreate(db, 'a', 'r1', 'running', 100)
    apply54(db)
    expect(db.prepare('SELECT COUNT(*) AS n FROM handoff_events').get()).toEqual({ n: 0 })
  })
})

function apply54(db: Database.Database): void {
  migrations.find((m) => m.version === 54)!.up(db)
}
