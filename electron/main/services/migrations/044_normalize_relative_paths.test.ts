import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'
import { up } from './044_normalize_relative_paths'

// Aplica 001-043 (algumas precisam de foreign_keys OFF, igual ao runner real) e
// PARA antes da 044: esta é uma migration de DADOS, então o teste precisa seedar
// as rows sujas antes de aplicá-la à mão.
function applyUpTo43(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version <= 43)) {
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

function setVaultRoot(db: Database.Database, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO app_prefs (key, value) VALUES ('vault_root', ?)`).run(value)
}

function seedRepo(db: Database.Database, id: string, path: string): void {
  db.prepare(
    `INSERT INTO repos (id, project_id, label, path, position, created_at)
     VALUES (?, 'p1', ?, ?, 0, ?)`,
  ).run(id, id, path, Date.now())
}

function seedFeatureRepo(db: Database.Database, repoId: string, worktreePath: string | null): void {
  db.prepare(
    `INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path)
     VALUES ('f1', ?, 'main', ?)`,
  ).run(repoId, worktreePath)
}

function repoPath(db: Database.Database, id: string): string {
  return (db.prepare(`SELECT path FROM repos WHERE id = ?`).get(id) as { path: string }).path
}

function vaultPath(db: Database.Database, id: string): string | null {
  return (
    db.prepare(`SELECT vault_path FROM projects WHERE id = ?`).get(id) as {
      vault_path: string | null
    }
  ).vault_path
}

function worktreePath(db: Database.Database, repoId: string): string | null {
  return (
    db.prepare(`SELECT worktree_path FROM feature_repos WHERE repo_id = ?`).get(repoId) as {
      worktree_path: string | null
    }
  ).worktree_path
}

describe('migration 044_normalize_relative_paths', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyUpTo43(db)
    db.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P1', ?, ?)`,
    ).run(Date.now(), Date.now())
    db.prepare(
      `INSERT INTO features (id, project_id, slug, title, status, doc_path, created_at, updated_at)
       VALUES ('f1', 'p1', 'f1', 'F1', 'active', '/tmp/f1.md', ?, ?)`,
    ).run(Date.now(), Date.now())
  })

  afterEach(() => {
    db.close()
  })

  it('com vault_root, normaliza rows relativas nas três colunas', () => {
    setVaultRoot(db, '/home/u/projetos')
    seedRepo(db, 'r1', 'diligencia/api')
    db.prepare(`UPDATE projects SET vault_path = 'pessoal/vault' WHERE id = 'p1'`).run()
    seedFeatureRepo(db, 'r1', 'diligencia/api/.worktrees/feat-x')

    up(db)

    expect(repoPath(db, 'r1')).toBe('/home/u/projetos/diligencia/api')
    expect(vaultPath(db, 'p1')).toBe('/home/u/projetos/pessoal/vault')
    expect(worktreePath(db, 'r1')).toBe('/home/u/projetos/diligencia/api/.worktrees/feat-x')
  })

  it('sem vault_root (ausente, vazio ou só espaços) é no-op — não chuta raiz nenhuma', () => {
    for (const pref of [null, '', '   ']) {
      db.prepare(`DELETE FROM app_prefs WHERE key = 'vault_root'`).run()
      if (pref !== null) setVaultRoot(db, pref)
      db.prepare(`DELETE FROM feature_repos`).run()
      db.prepare(`DELETE FROM repos`).run()
      seedRepo(db, 'r1', 'diligencia/api')
      db.prepare(`UPDATE projects SET vault_path = 'pessoal/vault' WHERE id = 'p1'`).run()
      seedFeatureRepo(db, 'r1', 'diligencia/api/.worktrees/feat-x')

      up(db)

      // Chutar ~/ClaudeManager fabricaria paths errados — exatamente o bug original.
      expect(repoPath(db, 'r1'), `pref=${JSON.stringify(pref)}`).toBe('diligencia/api')
      expect(vaultPath(db, 'p1')).toBe('pessoal/vault')
      expect(worktreePath(db, 'r1')).toBe('diligencia/api/.worktrees/feat-x')
    }
  })

  it('vault_root relativo também é no-op (resolveria pra outro path relativo)', () => {
    setVaultRoot(db, 'projetos')
    seedRepo(db, 'r1', 'diligencia/api')

    up(db)

    expect(repoPath(db, 'r1')).toBe('diligencia/api')
  })

  it('rows absolutas ficam intocadas e a migration é idempotente', () => {
    setVaultRoot(db, '/home/u/projetos')
    seedRepo(db, 'abs', '/opt/elsewhere/repo')
    seedRepo(db, 'rel', 'diligencia/api')
    db.prepare(`UPDATE projects SET vault_path = '/mnt/vault' WHERE id = 'p1'`).run()
    seedFeatureRepo(db, 'abs', '/opt/elsewhere/repo/.worktrees/w')
    seedFeatureRepo(db, 'rel', 'diligencia/api/.worktrees/w')

    up(db)
    const afterFirst = {
      abs: repoPath(db, 'abs'),
      rel: repoPath(db, 'rel'),
      vault: vaultPath(db, 'p1'),
      wtAbs: worktreePath(db, 'abs'),
      wtRel: worktreePath(db, 'rel'),
    }
    expect(afterFirst).toEqual({
      abs: '/opt/elsewhere/repo',
      rel: '/home/u/projetos/diligencia/api',
      vault: '/mnt/vault',
      wtAbs: '/opt/elsewhere/repo/.worktrees/w',
      wtRel: '/home/u/projetos/diligencia/api/.worktrees/w',
    })

    // Segunda passada não pode empilhar a raiz de novo.
    up(db)
    expect({
      abs: repoPath(db, 'abs'),
      rel: repoPath(db, 'rel'),
      vault: vaultPath(db, 'p1'),
      wtAbs: worktreePath(db, 'abs'),
      wtRel: worktreePath(db, 'rel'),
    }).toEqual(afterFirst)
  })

  it('NULL e string vazia não viram a raiz do vault', () => {
    setVaultRoot(db, '/home/u/projetos')
    seedRepo(db, 'r1', '/abs/r1')
    seedFeatureRepo(db, 'r1', null)
    seedRepo(db, 'r2', '/abs/r2')
    seedFeatureRepo(db, 'r2', '')

    up(db)

    expect(vaultPath(db, 'p1')).toBeNull()
    expect(worktreePath(db, 'r1')).toBeNull()
    expect(worktreePath(db, 'r2')).toBe('')
  })

  it('está registrada na cadeia como version 44', () => {
    const m = migrations.find((m) => m.version === 44)
    expect(m?.name).toBe('044_normalize_relative_paths')
    expect(migrations.at(-1)?.version).toBe(44)
  })
})
