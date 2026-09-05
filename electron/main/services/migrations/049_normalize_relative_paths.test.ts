import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'
import { up as up049 } from './049_normalize_relative_paths'

function applyUpTo048(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 49)) {
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

function setVaultRoot(db: Database.Database, root: string): void {
  db.prepare(`INSERT INTO app_prefs (key, value) VALUES ('vault_root', ?)`).run(root)
}

// Um projeto com vault relativo + dois repos (um relativo, um absoluto) + um
// worktree relativo: o cenário exato do banco afetado pelo importer do sync.
function seed(db: Database.Database): void {
  db.prepare(
    `INSERT INTO projects (id, name, created_at, updated_at, vault_path, position)
     VALUES ('p1', 'Diligencia', 1, 1, 'diligencia', 0)`,
  ).run()
  db.prepare(
    `INSERT INTO projects (id, name, created_at, updated_at, vault_path, position)
     VALUES ('p2', 'Outro', 1, 1, '/home/u/projetos/outro', 1)`,
  ).run()
  db.prepare(
    `INSERT INTO repos (id, project_id, label, path, position, created_at)
     VALUES ('r1', 'p1', 'api', 'diligencia/api', 0, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO repos (id, project_id, label, path, position, created_at)
     VALUES ('r2', 'p1', 'web', '/home/u/projetos/diligencia/web', 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO features (id, project_id, slug, title, status, doc_path, created_at, updated_at)
     VALUES ('f1', 'p1', 'x', 'X', 'active', 'docs/x.md', 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path)
     VALUES ('f1', 'r1', 'feat/x', 'diligencia/api/.worktrees/feat-x')`,
  ).run()
  db.prepare(
    `INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path)
     VALUES ('f1', 'r2', 'feat/x', NULL)`,
  ).run()
}

function paths(db: Database.Database) {
  return {
    projects: db
      .prepare('SELECT id, vault_path FROM projects ORDER BY id')
      .all() as { id: string; vault_path: string | null }[],
    repos: db.prepare('SELECT id, path FROM repos ORDER BY id').all() as {
      id: string
      path: string
    }[],
    worktrees: db
      .prepare('SELECT repo_id, worktree_path FROM feature_repos ORDER BY repo_id')
      .all() as { repo_id: string; worktree_path: string | null }[],
  }
}

describe('migration 049_normalize_relative_paths', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyUpTo048(db)
    seed(db)
  })

  afterEach(() => {
    db.close()
  })

  it('is registered as version 49', () => {
    const entry = migrations.find((m) => m.version === 49)
    expect(entry?.name).toBe('049_normalize_relative_paths')
  })

  it('resolve paths relativos contra o vault_root e deixa os absolutos intactos', () => {
    setVaultRoot(db, '/home/u/projetos')
    up049(db)
    const after = paths(db)
    expect(after.projects).toEqual([
      { id: 'p1', vault_path: '/home/u/projetos/diligencia' },
      { id: 'p2', vault_path: '/home/u/projetos/outro' },
    ])
    expect(after.repos).toEqual([
      { id: 'r1', path: '/home/u/projetos/diligencia/api' },
      { id: 'r2', path: '/home/u/projetos/diligencia/web' },
    ])
    expect(after.worktrees).toEqual([
      { repo_id: 'r1', worktree_path: '/home/u/projetos/diligencia/api/.worktrees/feat-x' },
      { repo_id: 'r2', worktree_path: null },
    ])
  })

  it('ignora barra final no vault_root', () => {
    setVaultRoot(db, '/home/u/projetos//')
    up049(db)
    expect(paths(db).repos[0]).toEqual({ id: 'r1', path: '/home/u/projetos/diligencia/api' })
  })

  it('sem vault_root em app_prefs não altera nada', () => {
    const before = paths(db)
    up049(db)
    expect(paths(db)).toEqual(before)
  })

  it('vault_root relativo (lixo) também é no-op', () => {
    setVaultRoot(db, 'projetos')
    const before = paths(db)
    up049(db)
    expect(paths(db)).toEqual(before)
  })

  it('é idempotente: rodar de novo não prefixa duas vezes', () => {
    setVaultRoot(db, '/home/u/projetos')
    up049(db)
    const once = paths(db)
    up049(db)
    expect(paths(db)).toEqual(once)
  })
})
