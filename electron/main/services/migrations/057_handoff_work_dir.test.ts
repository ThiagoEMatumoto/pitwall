import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'

function apply(db: Database.Database, from: number, upTo: number): void {
  for (const m of migrations.filter((x) => x.version >= from && x.version <= upTo)) {
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

function insertHandoff(
  db: Database.Database,
  id: string,
  repo: string,
  status: string,
  mode: string,
  createdAt: number,
  featureId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO handoffs (id, target_repo_id, feature_id, task, composed_prompt, status, mode, created_at, updated_at)
     VALUES (?, ?, ?, 't', 'p', ?, ?, ?, ?)`,
  ).run(id, repo, featureId, status, mode, createdAt, createdAt)
}

describe('migration 057_handoff_work_dir', () => {
  let db: Database.Database
  let worktree: string

  beforeEach(() => {
    db = new Database(':memory:')
    apply(db, 0, 56)
    worktree = mkdtempSync(join(tmpdir(), 'wt-057-'))
    db.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',1,1)`,
    ).run()
    db.prepare(
      `INSERT INTO repos (id, project_id, label, path, position, created_at)
       VALUES ('r1','p1','R1','/tmp/r1',0,1), ('r2','p1','R2','/tmp/r2',1,1),
              ('r2-alias','p1','R2 de novo','/tmp/r2',2,1)`,
    ).run()
    db.prepare(
      `INSERT INTO features (id, project_id, slug, title, status, doc_path, created_at, updated_at)
       VALUES ('f1','p1','f1','F1','in-progress','/tmp/f1.md',1,1)`,
    ).run()
    db.prepare(
      `INSERT INTO feature_repos (feature_id, repo_id, worktree_path) VALUES ('f1','r1',?)`,
    ).run(worktree)
  })

  afterEach(() => {
    db.close()
    rmSync(worktree, { recursive: true, force: true })
  })

  it('is registered as version 57', () => {
    expect(migrations.find((m) => m.version === 57)?.name).toBe('057_handoff_work_dir')
  })

  it('roda sobre banco com o índice da 054 e handoffs ativos sem falhar', () => {
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_handoffs_active_target'",
        )
        .get(),
    ).toBeDefined()
    insertHandoff(db, 'w-r1', 'r1', 'running', 'auto-edits', 100, 'f1')
    insertHandoff(db, 'w-r2', 'r2', 'needs_input', 'interactive', 100)
    // r2-alias aponta pro MESMO path que r2: sob a 054 eram repos distintos, sob a
    // 057 viram o mesmo diretório — fica a mais recente.
    insertHandoff(db, 'w-r2-alias', 'r2-alias', 'running', 'auto-edits', 200)
    insertHandoff(db, 'done', 'r1', 'done', 'auto-edits', 50)

    expect(() => apply(db, 57, 57)).not.toThrow()

    const row = (id: string) =>
      db.prepare('SELECT status, work_dir FROM handoffs WHERE id = ?').get(id) as {
        status: string
        work_dir: string | null
      }
    expect(row('w-r1')).toEqual({ status: 'running', work_dir: worktree })
    expect(row('w-r2')).toEqual({ status: 'interrupted', work_dir: '/tmp/r2' })
    expect(row('w-r2-alias')).toEqual({ status: 'running', work_dir: '/tmp/r2' })
    expect(row('done').work_dir).toBe('/tmp/r1')

    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_handoffs_active_%'",
      )
      .all() as Array<{ name: string }>
    expect(idx.map((i) => i.name)).toEqual(['idx_handoffs_active_work_dir'])
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM handoff_events WHERE event = 'migration_dedup'").get(),
    ).toEqual({ n: 1 })
  })

  it('o índice novo aceita writer em outro diretório e plan no mesmo, e recusa 2 writers', () => {
    insertHandoff(db, 'w-root', 'r1', 'running', 'auto-edits', 100)
    apply(db, 57, 57)
    const add = (id: string, mode: string, featureId: string | null, dir: string) => {
      db.prepare(
        `INSERT INTO handoffs (id, target_repo_id, feature_id, task, composed_prompt, status, mode, created_at, updated_at, work_dir)
         VALUES (?, 'r1', ?, 't', 'p', 'running', ?, 1, 1, ?)`,
      ).run(id, featureId, mode, dir)
    }
    expect(() => add('w-wt', 'auto-edits', 'f1', worktree)).not.toThrow()
    expect(() => add('reader', 'plan', null, '/tmp/r1')).not.toThrow()
    expect(() => add('w-root-2', 'interactive', null, '/tmp/r1')).toThrow(/UNIQUE/)
  })
})
