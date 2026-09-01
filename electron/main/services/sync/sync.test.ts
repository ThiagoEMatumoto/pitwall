import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// `exporter`/`importer` fazem `import { app } from 'electron'` (só como fallback;
// os testes injetam tudo). Mockamos electron minimamente para o módulo resolver.
// `feature-store` também importa electron/chokidar; ao mockar electron ele carrega.
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getVersion: () => '0.0.0-test',
  },
  BrowserWindow: { getAllWindows: () => [] },
}))

import {
  PATH_COLUMNS,
  SYNCED_TABLES,
  TABLE_PRIMARY_KEYS,
  ensureAbsolutePath,
  stableStringify,
} from './bundle-format'
import { exportBundle } from './exporter'
import { importBundle } from './importer'
import { migrations } from '../migrations/index'

// Aplica o schema REAL (todas as migrations, respeitando disableForeignKeys
// como o runner de produção).
function migrate(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`)
  const insert = db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)')
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
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
    insert.run(m.version, m.name, Date.now())
  }
}

function newDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

// Popula um DB com um grafo de dados realista cobrindo TODAS as tabelas
// sincronizadas e suas FKs.
function seed(db: Database.Database): void {
  const t = 1_700_000_000_000
  db.prepare(
    `INSERT INTO projects (id, name, color, icon, created_at, updated_at, position)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('proj-1', 'Projeto Um', '#fff', 'icon', t, t, 0)
  db.prepare(`INSERT INTO projects (id, name, created_at, updated_at, position) VALUES (?,?,?,?,?)`).run(
    'proj-2',
    'Projeto Dois',
    t,
    t,
    1,
  )

  db.prepare(
    `INSERT INTO repos (id, project_id, label, path, role, position, created_at, link_kind)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('repo-1', 'proj-1', 'core', '/home/x/core', 'primary', 0, t, 'external')
  db.prepare(
    `INSERT INTO repos (id, project_id, label, path, position, created_at, link_kind)
     VALUES (?,?,?,?,?,?,?)`,
  ).run('repo-2', 'proj-1', 'ui', '/home/x/ui', 1, t, 'external')

  db.prepare(
    `INSERT INTO repo_dependencies (id, from_repo_id, to_repo_id, kind, label, created_at) VALUES (?,?,?,?,?,?)`,
  ).run('dep-1', 'repo-2', 'repo-1', 'depends-on', null, t)

  db.prepare(
    `INSERT INTO features (id, project_id, slug, title, status, objective, doc_path, synth_mode, model, created_at, updated_at, completed_at, archived_at, origin)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'feat-1',
    'proj-1',
    'minha-feature',
    'Minha Feature',
    'in-progress',
    'fazer X',
    '/tmp/whatever/proj-1/minha-feature.md',
    'threshold',
    null,
    t,
    t,
    null,
    null,
    'manual',
  )

  db.prepare(
    `INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path) VALUES (?,?,?,?)`,
  ).run('feat-1', 'repo-1', 'feat/x', '/home/x/core/.worktrees/x')

  db.prepare(
    `INSERT INTO objectives (id, title, description, kind, status, tags, progress_mode, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run('obj-1', 'Objetivo', 'desc', 'okr', 'active', '["a","b"]', 'auto_rollup', t, t)
  // self-FK: obj-2 referencia obj-1 como parent
  db.prepare(
    `INSERT INTO objectives (id, title, kind, status, tags, progress_mode, parent_objective_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run('obj-2', 'Sub', 'custom', 'active', '[]', 'manual', 'obj-1', t, t)

  db.prepare(
    `INSERT INTO key_results (id, objective_id, title, status, progress_mode, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run('kr-1', 'obj-1', 'KR um', 'active', 'manual', t, t)

  db.prepare(
    `INSERT INTO tasks (id, title, description, status, tags, position, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('task-1', 'Tarefa', 'd', 'todo', '[]', 0, t, t)

  db.prepare(`INSERT INTO task_links (task_id, parent_type, parent_id) VALUES (?,?,?)`).run(
    'task-1',
    'objective',
    'obj-1',
  )
  db.prepare(`INSERT INTO feature_links (feature_id, target_type, target_id) VALUES (?,?,?)`).run(
    'feat-1',
    'key_result',
    'kr-1',
  )
}

// Lê uma tabela inteira ordenada por PK (forma canônica p/ comparação).
function dumpTable(db: Database.Database, table: string): unknown[] {
  const pk = (TABLE_PRIMARY_KEYS as Record<string, readonly string[]>)[table]
  const orderBy = pk.map((c) => `"${c}" ASC`).join(', ')
  return db.prepare(`SELECT * FROM "${table}" ORDER BY ${orderBy}`).all()
}

// features.doc_path é RECOMPUTADO no import contra a featuresRoot local (#1) →
// não é byte-igual com roots diferentes. Comparação de paridade sem doc_path.
function dumpTableSansDocPath(db: Database.Database, table: string): unknown[] {
  const rows = dumpTable(db, table) as Array<Record<string, unknown>>
  if (table !== 'features') return rows
  return rows.map(({ doc_path: _doc, ...rest }) => rest)
}

let dirs: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
  vi.restoreAllMocks()
})

// Watcher no-ops para isolar do chokidar/electron real.
const noopWatcher = {
  stopWatcher: () => {},
  startWatcher: () => {},
  markSelfWrite: () => {},
}

describe('sync bundle export/import', () => {
  it('1. round-trip: DB-A → export → import em DB-B limpo → igualdade linha-a-linha + .md', () => {
    const dbA = newDb()
    seed(dbA)

    const featRootA = tmp('sync-feat-a-')
    mkdirSync(join(featRootA, 'proj-1'), { recursive: true })
    const mdContent = '---\nid: feat-1\n---\n\n## Visão geral\n\nconteúdo verdade\n'
    writeFileSync(join(featRootA, 'proj-1', 'minha-feature.md'), mdContent)

    const bundleDir = tmp('sync-bundle-')
    exportBundle(dbA, bundleDir, { featuresRoot: featRootA, exportedAt: 1, appVersion: 'x' })

    const dbB = newDb()
    const featRootB = tmp('sync-feat-b-')
    importBundle(dbB, bundleDir, { featuresRoot: featRootB, ...noopWatcher })

    for (const table of SYNCED_TABLES) {
      expect(dumpTableSansDocPath(dbB, table), `tabela ${table}`).toEqual(
        dumpTableSansDocPath(dbA, table),
      )
    }
    // doc_path recomputado contra a featuresRoot LOCAL (#1).
    expect(
      (dbB.prepare(`SELECT doc_path FROM features WHERE id='feat-1'`).get() as { doc_path: string })
        .doc_path,
    ).toBe(join(featRootB, 'proj-1', 'minha-feature.md'))

    // .md reconciliado byte-a-byte.
    const importedMd = readFileSync(join(featRootB, 'proj-1', 'minha-feature.md'), 'utf8')
    expect(importedMd).toBe(mdContent)

    dbA.close()
    dbB.close()
  })

  it('2. idempotência: importBundle 2× = mesmo estado', () => {
    const dbA = newDb()
    seed(dbA)
    const bundleDir = tmp('sync-bundle-')
    const featRootA = tmp('sync-feat-a-')
    exportBundle(dbA, bundleDir, { featuresRoot: featRootA, exportedAt: 1 })

    const dbB = newDb()
    const featRootB = tmp('sync-feat-b-')
    importBundle(dbB, bundleDir, { featuresRoot: featRootB, ...noopWatcher })
    const after1 = SYNCED_TABLES.map((t) => dumpTable(dbB, t))
    importBundle(dbB, bundleDir, { featuresRoot: featRootB, ...noopWatcher })
    const after2 = SYNCED_TABLES.map((t) => dumpTable(dbB, t))

    expect(after2).toEqual(after1)
    dbA.close()
    dbB.close()
  })

  it('3. determinismo: export 2× sem mutação = arquivos byte-idênticos (diff git limpo)', () => {
    const db = newDb()
    seed(db)
    const featRoot = tmp('sync-feat-')

    const b1 = tmp('sync-bundle-1-')
    const b2 = tmp('sync-bundle-2-')
    exportBundle(db, b1, { featuresRoot: featRoot, exportedAt: 42 })
    exportBundle(db, b2, { featuresRoot: featRoot, exportedAt: 42 })

    for (const table of SYNCED_TABLES) {
      const f1 = readFileSync(join(b1, 'tables', `${table}.ndjson`), 'utf8')
      const f2 = readFileSync(join(b2, 'tables', `${table}.ndjson`), 'utf8')
      expect(f2, `ndjson ${table}`).toBe(f1)
    }
    // manifest idêntico quando exportedAt é fixo.
    expect(readFileSync(join(b2, 'manifest.json'), 'utf8')).toBe(
      readFileSync(join(b1, 'manifest.json'), 'utf8'),
    )
    db.close()
  })

  it('4. FK integrity: foreign_key_check vazio após import', () => {
    const dbA = newDb()
    seed(dbA)
    const bundleDir = tmp('sync-bundle-')
    const featRoot = tmp('sync-feat-')
    exportBundle(dbA, bundleDir, { featuresRoot: featRoot, exportedAt: 1 })

    const dbB = newDb()
    importBundle(dbB, bundleDir, { featuresRoot: tmp('sync-feat-b-'), ...noopWatcher })

    const violations = dbB.pragma('foreign_key_check') as unknown[]
    expect(violations).toEqual([])
    dbA.close()
    dbB.close()
  })

  it('5. schema guard: manifest.schemaVersion > local → erro claro', () => {
    const dbA = newDb()
    seed(dbA)
    const bundleDir = tmp('sync-bundle-')
    exportBundle(dbA, bundleDir, { featuresRoot: tmp('sync-feat-'), exportedAt: 1 })

    // Forja schemaVersion futura no manifest.
    const manifestFile = join(bundleDir, 'manifest.json')
    const m = JSON.parse(readFileSync(manifestFile, 'utf8'))
    m.schemaVersion = 9999
    writeFileSync(manifestFile, stableStringify(m) + '\n')

    const dbB = newDb()
    expect(() =>
      importBundle(dbB, bundleDir, { featuresRoot: tmp('sync-feat-b-'), ...noopWatcher }),
    ).toThrow(/atualize antes de importar/)
    dbA.close()
    dbB.close()
  })

  it('6. tabelas excluídas NÃO aparecem no bundle', () => {
    const db = newDb()
    seed(db)
    const bundleDir = tmp('sync-bundle-')
    exportBundle(db, bundleDir, { featuresRoot: tmp('sync-feat-'), exportedAt: 1 })

    const files = readdirSync(join(bundleDir, 'tables'))
    const excluded = [
      '_migrations',
      'metrics_session_cache',
      'sessions',
      'feature_session_records',
      'workspace_state',
      'layouts',
      'app_prefs',
    ]
    for (const ex of excluded) {
      expect(files).not.toContain(`${ex}.ndjson`)
    }
    // E só as sincronizadas estão presentes.
    expect(files.sort()).toEqual(SYNCED_TABLES.map((t) => `${t}.ndjson`).sort())
    db.close()
  })

  it('export poda .md órfão: arquivo no bundle ausente na origem é removido', () => {
    const db = newDb()
    seed(db)
    const featRoot = tmp('sync-feat-')
    mkdirSync(join(featRoot, 'proj-1'), { recursive: true })
    writeFileSync(join(featRoot, 'proj-1', 'a.md'), 'A')

    const bundleDir = tmp('sync-bundle-')
    exportBundle(db, bundleDir, { featuresRoot: featRoot, exportedAt: 1 })
    expect(existsSync(join(bundleDir, 'features', 'proj-1', 'a.md'))).toBe(true)

    // Remove o .md da origem e re-exporta no MESMO bundle → deve podar.
    rmSync(join(featRoot, 'proj-1', 'a.md'))
    exportBundle(db, bundleDir, { featuresRoot: featRoot, exportedAt: 1 })
    expect(existsSync(join(bundleDir, 'features', 'proj-1', 'a.md'))).toBe(false)
    db.close()
  })

  it('import remove .md local ausente no bundle', () => {
    const db = newDb()
    seed(db)
    const bundleDir = tmp('sync-bundle-')
    const featRootSrc = tmp('sync-feat-src-')
    exportBundle(db, bundleDir, { featuresRoot: featRootSrc, exportedAt: 1 })

    const dbB = newDb()
    const featRootB = tmp('sync-feat-b-')
    mkdirSync(join(featRootB, 'proj-9'), { recursive: true })
    writeFileSync(join(featRootB, 'proj-9', 'stale.md'), 'velho')

    importBundle(dbB, bundleDir, { featuresRoot: featRootB, ...noopWatcher })
    expect(existsSync(join(featRootB, 'proj-9', 'stale.md'))).toBe(false)
    db.close()
    dbB.close()
  })

  // ---- #1: features.doc_path recomputado a partir da featuresRoot LOCAL ----
  it('#1: doc_path é recomputado contra a featuresRoot local (não o path da origem)', () => {
    const dbA = newDb()
    seed(dbA) // feat-1: project_id=proj-1, slug=minha-feature, doc_path=/tmp/whatever/...
    const featRootA = tmp('sync-feat-a-')
    const bundleDir = tmp('sync-bundle-')
    exportBundle(dbA, bundleDir, { featuresRoot: featRootA, exportedAt: 1 })

    // O bundle carrega o doc_path da MÁQUINA A (verbatim).
    const exported = ndjson(bundleDir, 'features').find((f) => f.id === 'feat-1')!
    expect(exported.doc_path).toBe('/tmp/whatever/proj-1/minha-feature.md')

    // Import na máquina B com featuresRoot DIFERENTE → doc_path aponta pra B.
    const dbB = newDb()
    const featRootB = tmp('sync-feat-b-')
    importBundle(dbB, bundleDir, { featuresRoot: featRootB, ...noopWatcher })

    const row = dbB.prepare(`SELECT doc_path FROM features WHERE id='feat-1'`).get() as {
      doc_path: string
    }
    expect(row.doc_path).toBe(join(featRootB, 'proj-1', 'minha-feature.md'))
    expect(row.doc_path).not.toContain('/tmp/whatever') // não vazou o path da origem
    dbA.close()
    dbB.close()
  })

  // ---- #5: localizePath unresolved é contado e retornado ----
  it('#5: import de bundle portável SEM projectsRoot → unresolvedPaths > 0', () => {
    const dbA = newDb()
    seedPortable(dbA, '/home/x/ClaudeManager')
    const bundleDir = tmp('sync-bundle-')
    // Export COM raiz → paths viram <CM_ROOT>/... (portáveis).
    exportBundle(dbA, bundleDir, {
      featuresRoot: tmp('sync-feat-'),
      exportedAt: 1,
      projectsRoot: '/home/x/ClaudeManager',
    })

    // Import SEM projectsRoot local → sentinelas não resolvem.
    const dbB = newDb()
    const res = importBundle(dbB, bundleDir, {
      featuresRoot: tmp('sync-feat-b-'),
      ...noopWatcher,
      projectsRoot: null,
    })
    expect(res.unresolvedPaths).toBeGreaterThan(0)
    dbA.close()
    dbB.close()
  })

  // ---- #3: FK violation → rollback, DB local INALTERADO ----
  it('#3: bundle com FK órfã → lança E o DB local fica inalterado (rollback)', () => {
    const dbA = newDb()
    seed(dbA)
    const bundleDir = tmp('sync-bundle-')
    exportBundle(dbA, bundleDir, { featuresRoot: tmp('sync-feat-'), exportedAt: 1 })

    // Corrompe o bundle: aponta repos.project_id para um projeto inexistente.
    const reposFile = join(bundleDir, 'tables', 'repos.ndjson')
    const lines = readFileSync(reposFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const o = JSON.parse(l) as Record<string, unknown>
        o.project_id = 'proj-ORPHAN'
        return stableStringify(o)
      })
    writeFileSync(reposFile, lines.join('\n') + '\n')

    // DB local de destino com dados próprios (devem sobreviver ao import falho).
    const dbB = newDb()
    seed(dbB)
    const countBefore = (t: string): number =>
      (dbB.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get() as { c: number }).c
    const projBefore = countBefore('projects')
    const reposBefore = countBefore('repos')
    const nameBefore = (
      dbB.prepare(`SELECT name FROM projects WHERE id='proj-1'`).get() as { name: string }
    ).name

    expect(() =>
      importBundle(dbB, bundleDir, { featuresRoot: tmp('sync-feat-b-'), ...noopWatcher }),
    ).toThrow(/violação\(ões\) de FK/)

    // Rollback provado: contagens e dados idênticos ao estado pré-import.
    expect(countBefore('projects')).toBe(projBefore)
    expect(countBefore('repos')).toBe(reposBefore)
    expect(
      (dbB.prepare(`SELECT name FROM projects WHERE id='proj-1'`).get() as { name: string }).name,
    ).toBe(nameBefore)
    const violations = dbB.pragma('foreign_key_check') as unknown[]
    expect(violations).toEqual([])
    dbA.close()
    dbB.close()
  })
})

// ---- Portabilidade de paths (raiz por máquina) ----
//
// Seed específico de portabilidade: paths de projeto/repo/worktree, alguns SOB
// a raiz e outros FORA dela, para exercitar portablize/localize.
function seedPortable(db: Database.Database, root: string): void {
  const t = 1_700_000_000_000
  // proj-1: vault SOB a raiz; proj-2: vault FORA da raiz (path absoluto alheio).
  db.prepare(
    `INSERT INTO projects (id, name, vault_path, created_at, updated_at, position) VALUES (?,?,?,?,?,?)`,
  ).run('proj-1', 'P1', join(root, 'projetos', 'p1'), t, t, 0)
  db.prepare(
    `INSERT INTO projects (id, name, vault_path, created_at, updated_at, position) VALUES (?,?,?,?,?,?)`,
  ).run('proj-2', 'P2', '/opt/elsewhere/p2', t, t, 1)
  // proj-3: vault NULL (campo opcional) — deve passar intacto.
  db.prepare(
    `INSERT INTO projects (id, name, created_at, updated_at, position) VALUES (?,?,?,?,?)`,
  ).run('proj-3', 'P3', t, t, 2)

  // repo-1 SOB a raiz; repo-2 FORA.
  db.prepare(
    `INSERT INTO repos (id, project_id, label, path, position, created_at, link_kind) VALUES (?,?,?,?,?,?,?)`,
  ).run('repo-1', 'proj-1', 'core', join(root, 'projetos', 'p1', 'core'), 0, t, 'inside')
  db.prepare(
    `INSERT INTO repos (id, project_id, label, path, position, created_at, link_kind) VALUES (?,?,?,?,?,?,?)`,
  ).run('repo-2', 'proj-2', 'ext', '/opt/elsewhere/p2/ext', 1, t, 'external')

  db.prepare(
    `INSERT INTO features (id, project_id, slug, title, status, doc_path, synth_mode, created_at, updated_at, origin)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run('feat-1', 'proj-1', 'f', 'F', 'pending', '/x/proj-1/f.md', 'manual', t, t, 'manual')
  // worktree SOB a raiz.
  db.prepare(
    `INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path) VALUES (?,?,?,?)`,
  ).run('feat-1', 'repo-1', 'feat/x', join(root, 'projetos', 'p1', 'core', '.worktrees', 'x'))
  // worktree NULL — deve passar intacto.
  db.prepare(
    `INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path) VALUES (?,?,?,?)`,
  ).run('feat-1', 'repo-2', null, null)
}

function ndjson(bundleDir: string, table: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(bundleDir, 'tables', `${table}.ndjson`), 'utf8')
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('sync portabilidade de paths (raiz por máquina)', () => {
  const rootA = '/home/x/ClaudeManager'
  const rootB = '/Users/y/ClaudeManager'

  it('1. export sob raiz vira <CM_ROOT>/...; fora da raiz fica absoluto; NULL intacto', () => {
    const db = newDb()
    seedPortable(db, rootA)
    const bundleDir = tmp('sync-bundle-')
    exportBundle(db, bundleDir, {
      featuresRoot: tmp('sync-feat-'),
      exportedAt: 1,
      projectsRoot: rootA,
    })

    const repos = ndjson(bundleDir, 'repos')
    const r1 = repos.find((r) => r.id === 'repo-1')!
    const r2 = repos.find((r) => r.id === 'repo-2')!
    expect(r1.path).toBe('<CM_ROOT>/projetos/p1/core') // sob a raiz → portável
    expect(r2.path).toBe('/opt/elsewhere/p2/ext') // fora → absoluto inalterado

    const projects = ndjson(bundleDir, 'projects')
    expect(projects.find((p) => p.id === 'proj-1')!.vault_path).toBe('<CM_ROOT>/projetos/p1')
    expect(projects.find((p) => p.id === 'proj-2')!.vault_path).toBe('/opt/elsewhere/p2')
    expect(projects.find((p) => p.id === 'proj-3')!.vault_path).toBe(null) // NULL intacto

    const fr = ndjson(bundleDir, 'feature_repos')
    const w1 = fr.find((f) => f.repo_id === 'repo-1')!
    const w2 = fr.find((f) => f.repo_id === 'repo-2')!
    expect(w1.worktree_path).toBe('<CM_ROOT>/projetos/p1/core/.worktrees/x')
    expect(w2.worktree_path).toBe(null) // NULL intacto

    db.close()
  })

  it('2. import resolve <CM_ROOT>/... contra raiz LOCAL diferente (cross-root)', () => {
    const dbA = newDb()
    seedPortable(dbA, rootA)
    const bundleDir = tmp('sync-bundle-')
    exportBundle(dbA, bundleDir, {
      featuresRoot: tmp('sync-feat-'),
      exportedAt: 1,
      projectsRoot: rootA,
    })

    const dbB = newDb()
    importBundle(dbB, bundleDir, {
      featuresRoot: tmp('sync-feat-b-'),
      ...noopWatcher,
      projectsRoot: rootB, // raiz da OUTRA máquina
    })

    const r1 = dbB.prepare(`SELECT path FROM repos WHERE id='repo-1'`).get() as { path: string }
    const r2 = dbB.prepare(`SELECT path FROM repos WHERE id='repo-2'`).get() as { path: string }
    expect(r1.path).toBe(join(rootB, 'projetos/p1/core')) // resolveu contra rootB
    expect(r2.path).toBe('/opt/elsewhere/p2/ext') // absoluto alheio inalterado

    const p1 = dbB
      .prepare(`SELECT vault_path FROM projects WHERE id='proj-1'`)
      .get() as { vault_path: string }
    expect(p1.vault_path).toBe(join(rootB, 'projetos/p1'))
    const p3 = dbB
      .prepare(`SELECT vault_path FROM projects WHERE id='proj-3'`)
      .get() as { vault_path: string | null }
    expect(p3.vault_path).toBe(null)

    const w1 = dbB
      .prepare(`SELECT worktree_path FROM feature_repos WHERE repo_id='repo-1'`)
      .get() as { worktree_path: string }
    expect(w1.worktree_path).toBe(join(rootB, 'projetos/p1/core/.worktrees/x'))

    dbA.close()
    dbB.close()
  })

  it('3. determinismo cross-root: mesmos dados sob raízes diferentes → ndjson idêntico', () => {
    // Máquina A: dados sob rootA. Máquina B: dados estruturalmente iguais sob rootB.
    const dbA = newDb()
    seedPortable(dbA, rootA)
    const dbB = newDb()
    seedPortable(dbB, rootB)

    const bA = tmp('sync-bundle-a-')
    const bB = tmp('sync-bundle-b-')
    exportBundle(dbA, bA, { featuresRoot: tmp('feat-a-'), exportedAt: 7, projectsRoot: rootA })
    exportBundle(dbB, bB, { featuresRoot: tmp('feat-b-'), exportedAt: 7, projectsRoot: rootB })

    // Os ndjson das tabelas com path são IDÊNTICOS: o sentinela some a diferença
    // de máquina (o que mantém o diff git limpo no commit cross-máquina).
    for (const table of ['projects', 'repos', 'feature_repos']) {
      const fA = readFileSync(join(bA, 'tables', `${table}.ndjson`), 'utf8')
      const fB = readFileSync(join(bB, 'tables', `${table}.ndjson`), 'utf8')
      expect(fB, `ndjson ${table} cross-root`).toBe(fA)
    }

    dbA.close()
    dbB.close()
  })

  it('4. backward-compat: bundle legado (paths absolutos, sem sentinela) importa intacto', () => {
    // Export SEM projectsRoot → paths ficam absolutos (como bundles pré-feature).
    const dbA = newDb()
    seedPortable(dbA, rootA)
    const bundleDir = tmp('sync-bundle-')
    exportBundle(dbA, bundleDir, { featuresRoot: tmp('sync-feat-'), exportedAt: 1 })

    // Sem projectsRoot no export, nenhum path tem sentinela.
    const repos = ndjson(bundleDir, 'repos')
    expect(repos.find((r) => r.id === 'repo-1')!.path).toBe(join(rootA, 'projetos/p1/core'))

    // Import COM raiz local: como não há sentinela, paths absolutos passam intactos.
    const dbB = newDb()
    importBundle(dbB, bundleDir, {
      featuresRoot: tmp('sync-feat-b-'),
      ...noopWatcher,
      projectsRoot: rootB,
    })
    const r1 = dbB.prepare(`SELECT path FROM repos WHERE id='repo-1'`).get() as { path: string }
    expect(r1.path).toBe(join(rootA, 'projetos/p1/core')) // absoluto legado inalterado

    dbA.close()
    dbB.close()
  })

  it('5. round-trip same-root: A → export(rootA) → import(rootA) → igualdade linha-a-linha', () => {
    const dbA = newDb()
    seedPortable(dbA, rootA)
    const bundleDir = tmp('sync-bundle-')
    exportBundle(dbA, bundleDir, {
      featuresRoot: tmp('sync-feat-'),
      exportedAt: 1,
      projectsRoot: rootA,
    })

    const dbB = newDb()
    importBundle(dbB, bundleDir, {
      featuresRoot: tmp('sync-feat-b-'),
      ...noopWatcher,
      projectsRoot: rootA, // MESMA raiz → deve reconstruir exatamente o original
    })

    for (const table of ['projects', 'repos', 'feature_repos', 'features']) {
      expect(dumpTableSansDocPath(dbB, table), `tabela ${table}`).toEqual(
        dumpTableSansDocPath(dbA, table),
      )
    }
    dbA.close()
    dbB.close()
  })
})

// ---- #10: guard de drift entre as listas de sync e o schema REAL ----
//
// Cruza SYNCED_TABLES/PATH_COLUMNS contra o schema materializado pelas migrations
// reais. Pega: tabela removida do schema mas ainda em SYNCED_TABLES; coluna de
// path em PATH_COLUMNS que não existe; e — heurística que teria pego o #1 — uma
// coluna TEXT cujo nome cheira a path (path/dir/root) numa tabela sincronizada
// que NÃO está em PATH_COLUMNS nem na allowlist documentada.
describe('#10: drift schema vs listas de sync', () => {
  // Colunas TEXT "tipo path" cujo NÃO-pertencimento a PATH_COLUMNS é INTENCIONAL.
  // Cada entrada exige justificativa — senão a heurística falha (anti-#1).
  const PATH_ALLOWLIST: Record<string, string> = {
    // features.doc_path vive sob <userData>/features (FORA da <CM_ROOT>), então
    // não é portablizado; é RECOMPUTADO no import a partir da featuresRoot local
    // + project_id + slug. Por isso fica fora de PATH_COLUMNS de propósito (#1).
    'features.doc_path': 'recomputado no import (não portablizado)',
  }

  function tableExists(db: Database.Database, t: string): boolean {
    const r = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(t) as { name: string } | undefined
    return !!r
  }

  function columns(db: Database.Database, t: string): Array<{ name: string; type: string }> {
    return db.pragma(`table_info(${t})`) as Array<{ name: string; type: string }>
  }

  it('toda tabela em SYNCED_TABLES existe no schema real', () => {
    const db = newDb()
    for (const t of SYNCED_TABLES) {
      expect(tableExists(db, t), `tabela ${t} ausente no schema`).toBe(true)
    }
    db.close()
  })

  it('toda coluna em PATH_COLUMNS existe na sua tabela', () => {
    const db = newDb()
    for (const [table, cols] of Object.entries(PATH_COLUMNS)) {
      const have = new Set(columns(db, table).map((c) => c.name))
      for (const c of cols ?? []) {
        expect(have.has(c), `coluna de path ${table}.${c} ausente no schema`).toBe(true)
      }
    }
    db.close()
  })

  it('heurística anti-#1: coluna TEXT path/dir/root sincronizada ⊆ PATH_COLUMNS ∪ allowlist', () => {
    const db = newDb()
    const offenders: string[] = []
    for (const t of SYNCED_TABLES) {
      const pathCols = new Set(PATH_COLUMNS[t] ?? [])
      for (const col of columns(db, t)) {
        const isTextish = /TEXT|CHAR|CLOB/i.test(col.type) || col.type === ''
        // "cheira a path": contém o token path, OU termina/usa dir|root como
        // sufixo de palavra (`_dir`, `worktree`, `*root`). Evita falsos-positivos
        // como `direction` (substring "dir" mas não é path).
        const n = col.name.toLowerCase()
        const smellsPath =
          /path/.test(n) || /(^|_)(dir|root)$/.test(n) || /_(dir|root)(_|$)/.test(n)
        if (!isTextish || !smellsPath) continue
        const key = `${t}.${col.name}`
        if (pathCols.has(col.name)) continue
        if (PATH_ALLOWLIST[key]) continue
        offenders.push(key)
      }
    }
    // Qualquer coluna de path nova numa tabela sincronizada quebra aqui até ser
    // adicionada a PATH_COLUMNS (portabilizar) OU à allowlist (com justificativa).
    expect(offenders, `colunas de path não-cobertas: ${offenders.join(', ')}`).toEqual([])
    db.close()
  })
})

// ---- Compatibilidade entre versões: tabela AUSENTE no bundle ----
//
// O exporter escreve SEMPRE um arquivo por tabela que conhece (inclusive vazio),
// então arquivo ausente significa "a versão que exportou não conhece esta
// tabela". Aqui simulamos a máquina antiga exportando um bundle completo e
// removendo os .ndjson das tabelas do loop — as que a versão anterior não tem.
const LOOP_TABLES = [
  'feature_pulses',
  'feature_ledger',
  'feature_metrics',
  'feature_metric_points',
]

function seedLoop(db: Database.Database, featureId: string, suffix: string): void {
  const t = 1_700_000_000_000
  db.prepare(
    `INSERT INTO feature_pulses (id, feature_id, body, source, created_at) VALUES (?,?,?,?,?)`,
  ).run(`pulse-${suffix}`, featureId, `pulso ${suffix}`, 'human', t)
  db.prepare(
    `INSERT INTO feature_ledger (feature_id, entry_id, title, body, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(featureId, `entry-${suffix}`, 'Entrada', 'corpo', t, t)
  db.prepare(`INSERT INTO feature_metrics (feature_id, column_key, label) VALUES (?,?,?)`).run(
    featureId,
    `metric-${suffix}`,
    'Métrica',
  )
  db.prepare(
    `INSERT INTO feature_metric_points (id, feature_id, column_key, at, value) VALUES (?,?,?,?,?)`,
  ).run(`point-${suffix}`, featureId, `metric-${suffix}`, t, 1)
}

// Remove do bundle os .ndjson das tabelas do loop = bundle exportado por uma
// versão que não as conhece.
function stripLoopTables(bundleDir: string): void {
  for (const t of LOOP_TABLES) rmSync(join(bundleDir, 'tables', `${t}.ndjson`))
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c
}

describe('sync import: bundle de versão anterior (tabela ausente)', () => {
  it('tabela SEM arquivo no bundle é preservada; as presentes são substituídas', () => {
    const dbA = newDb()
    seed(dbA)
    dbA.prepare(`UPDATE projects SET name='Vindo do bundle' WHERE id='proj-1'`).run()
    const bundleDir = tmp('sync-bundle-')
    exportBundle(dbA, bundleDir, { featuresRoot: tmp('sync-feat-'), exportedAt: 1 })
    stripLoopTables(bundleDir)

    const dbB = newDb()
    seed(dbB)
    seedLoop(dbB, 'feat-1', 'b')
    dbB.prepare(`UPDATE projects SET name='Local' WHERE id='proj-1'`).run()

    importBundle(dbB, bundleDir, { featuresRoot: tmp('sync-feat-b-'), ...noopWatcher })

    // Preservadas: o bundle nada dizia sobre elas.
    for (const t of LOOP_TABLES) expect(count(dbB, t), `tabela ${t}`).toBe(1)
    expect(
      (
        dbB.prepare(`SELECT body FROM feature_pulses WHERE id='pulse-b'`).get() as {
          body: string
        }
      ).body,
    ).toBe('pulso b')

    // Substituídas: replace-all normal nas tabelas presentes no bundle.
    expect(
      (dbB.prepare(`SELECT name FROM projects WHERE id='proj-1'`).get() as { name: string }).name,
    ).toBe('Vindo do bundle')
    expect(dbB.pragma('foreign_key_check')).toEqual([])

    dbA.close()
    dbB.close()
  })

  it('arquivo PRESENTE e vazio continua limpando a tabela (a distinção é o ponto)', () => {
    const dbA = newDb()
    seed(dbA) // sem linhas de loop => .ndjson presente e vazio
    const bundleDir = tmp('sync-bundle-')
    exportBundle(dbA, bundleDir, { featuresRoot: tmp('sync-feat-'), exportedAt: 1 })
    for (const t of LOOP_TABLES) {
      expect(readFileSync(join(bundleDir, 'tables', `${t}.ndjson`), 'utf8').trim()).toBe('')
    }

    const dbB = newDb()
    seed(dbB)
    seedLoop(dbB, 'feat-1', 'b')

    importBundle(dbB, bundleDir, { featuresRoot: tmp('sync-feat-b-'), ...noopWatcher })

    for (const t of LOOP_TABLES) expect(count(dbB, t), `tabela ${t}`).toBe(0)
    dbA.close()
    dbB.close()
  })

  it('preservada com pai que sumiu no replace-all: só as órfãs caem, import não falha', () => {
    const dbA = newDb()
    seed(dbA) // bundle só conhece feat-1
    const bundleDir = tmp('sync-bundle-')
    exportBundle(dbA, bundleDir, { featuresRoot: tmp('sync-feat-'), exportedAt: 1 })
    stripLoopTables(bundleDir)

    const dbB = newDb()
    seed(dbB)
    // Feature que só existe NESTA máquina: some no replace-all, e o loop dela vai junto.
    dbB.prepare(
      `INSERT INTO features (id, project_id, slug, title, status, doc_path, synth_mode, created_at, updated_at, origin)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'feat-local',
      'proj-1',
      'so-daqui',
      'Só daqui',
      'pending',
      '/x/proj-1/so-daqui.md',
      'manual',
      1,
      1,
      'manual',
    )
    seedLoop(dbB, 'feat-1', 'keep')
    seedLoop(dbB, 'feat-local', 'drop')

    importBundle(dbB, bundleDir, { featuresRoot: tmp('sync-feat-b-'), ...noopWatcher })

    expect(dbB.prepare(`SELECT id FROM feature_pulses ORDER BY id`).all()).toEqual([
      { id: 'pulse-keep' },
    ])
    expect(count(dbB, 'feature_metric_points')).toBe(1) // órfã em 2 saltos também caiu
    expect(dbB.pragma('foreign_key_check')).toEqual([])

    dbA.close()
    dbB.close()
  })
})

// ---- Regressão: import NUNCA persiste path relativo (bug repos.path relativo) ----
//
// O importer antigo gravava o retorno de localizePath mesmo quando unresolved
// (sem projectsRoot local), deixando `repos.path = 'projetos/x'` no DB — o que
// quebrava existsSync/statSync/cwd de spawn. Estes testes cravam as 3 saídas:
// absolutizar contra a raiz local, preservar o row local, e (último caso) o
// comportamento antigo contado em unresolvedPaths.
describe('import nunca persiste path relativo', () => {
  const rootA = '/home/x/ClaudeManager'

  it('ensureAbsolutePath: absoluto intacto; relativo resolve contra a raiz; sem raiz preserva o existente', () => {
    // Absoluto → intacto, resolvido.
    expect(ensureAbsolutePath('/abs/x', '/root')).toEqual({ value: '/abs/x', unresolved: false })
    expect(ensureAbsolutePath('/abs/x', null)).toEqual({ value: '/abs/x', unresolved: false })
    // NULL/vazio → intacto (campos opcionais).
    expect(ensureAbsolutePath(null, '/root')).toEqual({ value: null, unresolved: false })
    expect(ensureAbsolutePath('', '/root')).toEqual({ value: '', unresolved: false })
    // Relativo + raiz (com e sem barra final) → absoluto.
    expect(ensureAbsolutePath('rel/x', '/root')).toEqual({ value: '/root/rel/x', unresolved: false })
    expect(ensureAbsolutePath('rel/x', '/root/')).toEqual({
      value: '/root/rel/x',
      unresolved: false,
    })
    // Relativo sem raiz + existente absoluto → preserva o existente (unresolved).
    expect(ensureAbsolutePath('rel/x', null, '/local/old')).toEqual({
      value: '/local/old',
      unresolved: true,
    })
    // Relativo sem raiz e sem existente utilizável → mantém (unresolved).
    expect(ensureAbsolutePath('rel/x', null)).toEqual({ value: 'rel/x', unresolved: true })
    expect(ensureAbsolutePath('rel/x', null, 'tambem/relativo')).toEqual({
      value: 'rel/x',
      unresolved: true,
    })
  })

  it('import portável SEM projectsRoot mas COM vault_root local → paths absolutos sob o vault, 0 unresolved', () => {
    const dbA = newDb()
    seedPortable(dbA, rootA)
    const bundleDir = tmp('sync-bundle-')
    exportBundle(dbA, bundleDir, {
      featuresRoot: tmp('sync-feat-'),
      exportedAt: 1,
      projectsRoot: rootA,
    })

    const vaultB = '/Users/y/Vault'
    const dbB = newDb()
    dbB.prepare(`INSERT INTO app_prefs (key, value) VALUES ('vault_root', ?)`).run(vaultB)
    const res = importBundle(dbB, bundleDir, {
      featuresRoot: tmp('sync-feat-b-'),
      ...noopWatcher,
      projectsRoot: null,
    })

    expect(res.unresolvedPaths).toBe(0)
    const repo = dbB.prepare(`SELECT path FROM repos WHERE id='repo-1'`).get() as { path: string }
    expect(repo.path).toBe(join(vaultB, 'projetos', 'p1', 'core'))
    const proj = dbB.prepare(`SELECT vault_path FROM projects WHERE id='proj-1'`).get() as {
      vault_path: string
    }
    expect(proj.vault_path).toBe(join(vaultB, 'projetos', 'p1'))
    const wt = dbB
      .prepare(`SELECT worktree_path FROM feature_repos WHERE repo_id='repo-1'`)
      .get() as { worktree_path: string }
    expect(wt.worktree_path).toBe(join(vaultB, 'projetos', 'p1', 'core', '.worktrees', 'x'))
    // Fora da raiz na origem: absoluto legado passa intacto.
    const ext = dbB.prepare(`SELECT path FROM repos WHERE id='repo-2'`).get() as { path: string }
    expect(ext.path).toBe('/opt/elsewhere/p2/ext')
    dbA.close()
    dbB.close()
  })

  it('import portável SEM raiz nenhuma → preserva o path do row local (não sobrescreve com relativo)', () => {
    const dbA = newDb()
    seedPortable(dbA, rootA)
    const bundleDir = tmp('sync-bundle-')
    exportBundle(dbA, bundleDir, {
      featuresRoot: tmp('sync-feat-'),
      exportedAt: 1,
      projectsRoot: rootA,
    })

    // Máquina B: MESMOS rows já existem localmente com paths absolutos próprios.
    const rootB = '/Users/y/ClaudeManager'
    const dbB = newDb()
    seedPortable(dbB, rootB)
    const res = importBundle(dbB, bundleDir, {
      featuresRoot: tmp('sync-feat-b-'),
      ...noopWatcher,
      projectsRoot: null,
    })

    // Não dava pra resolver (sem raiz) → sinaliza pra UI pedir a configuração…
    expect(res.unresolvedPaths).toBeGreaterThan(0)
    // …mas o valor local absoluto foi PRESERVADO em vez de virar lixo relativo.
    const repo = dbB.prepare(`SELECT path FROM repos WHERE id='repo-1'`).get() as { path: string }
    expect(repo.path).toBe(join(rootB, 'projetos', 'p1', 'core'))
    const proj = dbB.prepare(`SELECT vault_path FROM projects WHERE id='proj-1'`).get() as {
      vault_path: string
    }
    expect(proj.vault_path).toBe(join(rootB, 'projetos', 'p1'))
    const wt = dbB
      .prepare(`SELECT worktree_path FROM feature_repos WHERE repo_id='repo-1'`)
      .get() as { worktree_path: string }
    expect(wt.worktree_path).toBe(join(rootB, 'projetos', 'p1', 'core', '.worktrees', 'x'))
    dbA.close()
    dbB.close()
  })

  it('bundle envenenado com path RELATIVO direto (sem sentinela) → absolutizado contra o vault_root', () => {
    const dbA = newDb()
    seedPortable(dbA, rootA)
    const bundleDir = tmp('sync-bundle-')
    // Export SEM raiz → paths absolutos; envenenamos o ndjson com um relativo,
    // como um bundle exportado de um DB já contaminado pelo bug antigo.
    exportBundle(dbA, bundleDir, { featuresRoot: tmp('sync-feat-'), exportedAt: 1 })
    const reposFile = join(bundleDir, 'tables', 'repos.ndjson')
    const lines = readFileSync(reposFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const o = JSON.parse(l) as Record<string, unknown>
        if (o.id === 'repo-1') o.path = 'projetos/p1/core'
        return stableStringify(o)
      })
    writeFileSync(reposFile, lines.join('\n') + '\n')

    const vaultB = '/Users/y/Vault'
    const dbB = newDb()
    dbB.prepare(`INSERT INTO app_prefs (key, value) VALUES ('vault_root', ?)`).run(vaultB)
    const res = importBundle(dbB, bundleDir, {
      featuresRoot: tmp('sync-feat-b-'),
      ...noopWatcher,
      projectsRoot: null,
    })

    expect(res.unresolvedPaths).toBe(0)
    const repo = dbB.prepare(`SELECT path FROM repos WHERE id='repo-1'`).get() as { path: string }
    expect(repo.path).toBe(join(vaultB, 'projetos', 'p1', 'core'))
    dbA.close()
    dbB.close()
  })
})

// ---- Regressão: export NUNCA emite path relativo (fail-closed no escritor) ----
//
// O leitor já se defende (ensureAbsolutePath), mas o escritor não: um DB já
// contaminado pelo bug antigo exportava `repos.path = 'projetos/x'` verbatim e
// publicava a contaminação pra todas as máquinas. O exporter agora recusa —
// melhor um sync que falha alto do que um bundle envenenado no remoto.
describe('export nunca emite path relativo', () => {
  it('repos.path relativo → exportBundle lança e não grava o relativo no ndjson', () => {
    const db = newDb()
    seed(db)
    db.prepare(`UPDATE repos SET path = ? WHERE id = 'repo-1'`).run('projetos/x')
    const bundleDir = tmp('sync-bundle-')

    expect(() =>
      exportBundle(db, bundleDir, { featuresRoot: tmp('sync-feat-'), exportedAt: 1 }),
    ).toThrow(/repos\.path/)

    const reposFile = join(bundleDir, 'tables', 'repos.ndjson')
    const content = existsSync(reposFile) ? readFileSync(reposFile, 'utf8') : ''
    expect(content).not.toContain('projetos/x')
    db.close()
  })

  it('coluna *_path FORA de PATH_COLUMNS também é checada (features.doc_path)', () => {
    const db = newDb()
    seed(db)
    db.prepare(`UPDATE features SET doc_path = ? WHERE id = 'feat-1'`).run('rel/f.md')
    const bundleDir = tmp('sync-bundle-')

    expect(() =>
      exportBundle(db, bundleDir, { featuresRoot: tmp('sync-feat-'), exportedAt: 1 }),
    ).toThrow(/features\.doc_path/)
    db.close()
  })

  it('path portável (<CM_ROOT>/...) e NULL passam — a checagem é só contra relativo', () => {
    const db = newDb()
    seedPortable(db, '/home/x/ClaudeManager')
    const bundleDir = tmp('sync-bundle-')

    expect(() =>
      exportBundle(db, bundleDir, {
        featuresRoot: tmp('sync-feat-'),
        exportedAt: 1,
        projectsRoot: '/home/x/ClaudeManager',
      }),
    ).not.toThrow()

    expect(ndjson(bundleDir, 'repos').find((r) => r.id === 'repo-1')!.path).toBe(
      '<CM_ROOT>/projetos/p1/core',
    )
    db.close()
  })
})
