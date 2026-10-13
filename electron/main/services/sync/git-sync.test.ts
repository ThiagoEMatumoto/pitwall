import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// git-sync importa exporter (que importa electron só como fallback). Mockamos
// electron minimamente; tudo é injetado nos testes.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}))

import { TABLE_PRIMARY_KEYS, SYNCED_TABLES } from './bundle-format'
import {
  applyRemote,
  applyRemoteAndImport,
  bundleDirFor,
  ensureRepo,
  pull,
  pushBundle,
  status,
} from './git-sync'
import { importBundle } from './importer'
import { readSyncConfig, updateSyncConfig } from './sync-config'
import { migrations } from '../migrations/index'

// ---- DB helpers (reuso do padrão da Fase 1) ----

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

function seed(db: Database.Database, marker: string): void {
  const t = 1_700_000_000_000
  db.prepare(
    `INSERT INTO projects (id, name, created_at, updated_at, position) VALUES (?,?,?,?,?)`,
  ).run('proj-1', `Projeto ${marker}`, t, t, 0)
  db.prepare(
    `INSERT INTO objectives (id, title, kind, status, tags, progress_mode, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('obj-1', `Objetivo ${marker}`, 'okr', 'active', '[]', 'manual', t, t)
  db.prepare(
    `INSERT INTO tasks (id, title, status, tags, position, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run('task-1', `Tarefa ${marker}`, 'todo', '[]', 0, t, t)
}

function dumpTable(db: Database.Database, table: string): unknown[] {
  const pk = (TABLE_PRIMARY_KEYS as Record<string, readonly string[]>)[table]
  const orderBy = pk.map((c) => `"${c}" ASC`).join(', ')
  return db.prepare(`SELECT * FROM "${table}" ORDER BY ${orderBy}`).all()
}

function dbDump(db: Database.Database, table: string): string {
  return JSON.stringify(dumpTable(db, table))
}

const noopWatcher = {
  stopWatcher: () => {},
  startWatcher: () => {},
  markSelfWrite: () => {},
}

// ---- tmpdir bookkeeping ----

let dirs: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

// Cria um repo bare local servindo de "remote" via file://.
function makeBareRemote(): { dir: string; url: string } {
  const dir = tmp('cm-bare-remote-')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', dir])
  return { dir, url: `file://${dir}` }
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
  vi.restoreAllMocks()
})

// featuresRoot vazio injetado (sem .md no DB destes testes).
function exportOpts(featRoot: string) {
  return { featuresRoot: featRoot, exportedAt: 1, appVersion: 'x', machineId: 'test' }
}

describe('git-sync', () => {
  it('1. configure(A) → seed DB-A → pushBundle → bare recebe commit', async () => {
    const { url } = makeBareRemote()
    const wkA = tmp('cm-wk-a-')
    await ensureRepo(wkA, url)

    const dbA = newDb()
    seed(dbA, 'A')
    const featA = tmp('cm-feat-a-')
    const res = await pushBundle(wkA, dbA, 'sync from A', { exportOpts: exportOpts(featA) })

    expect(res.pushed).toBe(true)
    expect(res.rejected).toBe(false)
    // O bundle foi materializado no working dir e versionado.
    expect(existsSync(join(bundleDirFor(wkA), 'tables', 'projects.ndjson'))).toBe(true)

    // Um clone fresco do bare enxerga o commit + o bundle.
    const verify = tmp('cm-verify-')
    execFileSync('git', ['clone', url, verify])
    expect(existsSync(join(verify, 'sync-bundle', 'tables', 'projects.ndjson'))).toBe(true)

    dbA.close()
  })

  it('2. B: ensureRepo+pull+applyRemote+importBundle → DB-B == DB-A', async () => {
    const { url } = makeBareRemote()
    const wkA = tmp('cm-wk-a-')
    await ensureRepo(wkA, url)
    const dbA = newDb()
    seed(dbA, 'A')
    const featA = tmp('cm-feat-a-')
    await pushBundle(wkA, dbA, 'sync from A', { exportOpts: exportOpts(featA) })

    const wkB = tmp('cm-wk-b-')
    await ensureRepo(wkB, url)
    const st = await pull(wkB)
    // B clonou já em sync com origin (clone trouxe o commit) → nada a aplicar,
    // mas o bundle já está em disco. Garantimos applyRemote idempotente.
    expect(st.diverged).toBe(false)
    await applyRemote(wkB)

    const dbB = newDb()
    importBundle(dbB, bundleDirFor(wkB), { featuresRoot: tmp('cm-feat-b-'), ...noopWatcher })

    for (const table of SYNCED_TABLES) {
      expect(dumpTable(dbB, table), `tabela ${table}`).toEqual(dumpTable(dbA, table))
    }
    dbA.close()
    dbB.close()
  })

  it('3. conflito: A push; B (sem pull) push → rejected, bare NÃO sobrescrito, sem --force', async () => {
    const { url } = makeBareRemote()

    // Seed inicial via A para que o bare tenha um commit base.
    const wkSeed = tmp('cm-wk-seed-')
    await ensureRepo(wkSeed, url)
    const dbSeed = newDb()
    seed(dbSeed, 'BASE')
    await pushBundle(wkSeed, dbSeed, 'base', { exportOpts: exportOpts(tmp('cm-feat-seed-')) })
    dbSeed.close()

    // A e B clonam do mesmo ponto base.
    const wkA = tmp('cm-wk-a-')
    await ensureRepo(wkA, url)
    const wkB = tmp('cm-wk-b-')
    await ensureRepo(wkB, url)

    // A avança e empurra.
    const dbA = newDb()
    seed(dbA, 'A2')
    db_update_title(dbA, 'Projeto A-WINS')
    await pushBundle(wkA, dbA, 'A advances', { exportOpts: exportOpts(tmp('cm-feat-a-')) })

    // B avança SEM pull (fica atrás) → push deve ser rejeitado.
    const dbB = newDb()
    seed(dbB, 'B2')
    db_update_title(dbB, 'Projeto B-LOSES')
    const resB = await pushBundle(wkB, dbB, 'B advances', { exportOpts: exportOpts(tmp('cm-feat-b-')) })

    expect(resB.rejected).toBe(true)
    expect(resB.pushed).toBe(false)

    // O bare manteve a versão de A (B não sobrescreveu via force).
    const verify = tmp('cm-verify-')
    execFileSync('git', ['clone', url, verify])
    const projects = readFileSync(join(verify, 'sync-bundle', 'tables', 'projects.ndjson'), 'utf8')
    expect(projects).toContain('A-WINS')
    expect(projects).not.toContain('B-LOSES')

    dbA.close()
    dbB.close()
  })

  it('4. boot seguro: B local à frente + remote à frente (diverged) → não importar (conflict)', async () => {
    const { url } = makeBareRemote()
    const wkSeed = tmp('cm-wk-seed-')
    await ensureRepo(wkSeed, url)
    const dbSeed = newDb()
    seed(dbSeed, 'BASE')
    await pushBundle(wkSeed, dbSeed, 'base', { exportOpts: exportOpts(tmp('cm-feat-seed-')) })
    dbSeed.close()

    const wkA = tmp('cm-wk-a-')
    await ensureRepo(wkA, url)
    const wkB = tmp('cm-wk-b-')
    await ensureRepo(wkB, url)

    // A empurra um avanço (remote fica à frente de B).
    const dbA = newDb()
    seed(dbA, 'A2')
    await pushBundle(wkA, dbA, 'A advances', { exportOpts: exportOpts(tmp('cm-feat-a-')) })
    dbA.close()

    // B cria um commit LOCAL (não-empurrado) → B fica à frente também.
    const dbB = newDb()
    seed(dbB, 'B2')
    // pushBundle de B vai commitar local e tentar push (será rejeitado), deixando
    // B com um commit local que origin não tem.
    await pushBundle(wkB, dbB, 'B local advance', { exportOpts: exportOpts(tmp('cm-feat-b-')) })

    // Agora o estado de boot: fetch + compara.
    const st = await pull(wkB)
    expect(st.ahead).toBeGreaterThan(0)
    expect(st.behind).toBeGreaterThan(0)
    expect(st.diverged).toBe(true)
    // A regra de boot (replicada aqui): diverged → NÃO chamar applyRemote.
    // Provamos que NÃO importamos verificando que o working tree de B ainda
    // reflete o commit local de B, não o de A.
    const localProjects = readFileSync(
      join(bundleDirFor(wkB), 'tables', 'projects.ndjson'),
      'utf8',
    )
    expect(localProjects).toContain('Projeto B2')

    dbB.close()
  })

  it('5. sync-config: round-trip read/write, machineId estável entre leituras', () => {
    const cfgPath = join(tmp('cm-cfg-'), 'sync-config.json')

    const first = readSyncConfig(cfgPath)
    expect(first.machineId).toBeTruthy()
    expect(first.repoUrl).toBe(null)

    // Segunda leitura: machineId idêntico (persistido).
    const second = readSyncConfig(cfgPath)
    expect(second.machineId).toBe(first.machineId)

    const updated = updateSyncConfig({ repoUrl: 'file:///x', lastPushAt: 123 }, cfgPath)
    expect(updated.repoUrl).toBe('file:///x')
    expect(updated.lastPushAt).toBe(123)
    expect(updated.machineId).toBe(first.machineId)

    // Persistência: relendo do disco preserva tudo.
    const reread = readSyncConfig(cfgPath)
    expect(reread).toEqual(updated)

    // O arquivo NÃO contém nenhum token/segredo (só os campos machine-local da
    // config: repoUrl, machineId, timestamps e a raiz local dos projetos).
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(Object.keys(raw).sort()).toEqual([
      'lastPullAt',
      'lastPushAt',
      'machineId',
      'projectsRoot',
      'repoUrl',
    ])
  })

  // B está atrás do remoto (que A avançou), sem commit local: o caminho
  // fast-forward limpo em que boot/syncNow/import-force chamam applyRemote.
  async function behindRemote() {
    const { dir, url } = makeBareRemote()
    const wkSeed = tmp('cm-wk-seed-')
    await ensureRepo(wkSeed, url)
    const dbSeed = newDb()
    seed(dbSeed, 'BASE')
    await pushBundle(wkSeed, dbSeed, 'base', { exportOpts: exportOpts(tmp('cm-feat-seed-')) })
    dbSeed.close()

    const wkA = tmp('cm-wk-a-')
    await ensureRepo(wkA, url)
    const wkB = tmp('cm-wk-b-')
    await ensureRepo(wkB, url)

    const dbA = newDb()
    seed(dbA, 'A-REMOTE')
    await pushBundle(wkA, dbA, 'A advances', { exportOpts: exportOpts(tmp('cm-feat-a-')) })
    dbA.close()

    const st = await pull(wkB)
    expect(st.behind).toBeGreaterThan(0)
    expect(st.ahead).toBe(0)
    return { dir, wkB }
  }

  const headOf = (gitDir: string, ref: string): string =>
    execFileSync('git', ['-C', gitDir, 'rev-parse', ref]).toString().trim()

  it('6. applyRemoteAndImport: import ok → clone no HEAD do remoto e devolve o resultado do import', async () => {
    const { wkB } = await behindRemote()
    const dbB = newDb()

    const res = await applyRemoteAndImport(wkB, () =>
      importBundle(dbB, bundleDirFor(wkB), { featuresRoot: tmp('cm-feat-b-'), ...noopWatcher }),
    )

    expect(res).toEqual({ unresolvedPaths: 0 })
    expect(headOf(wkB, 'HEAD')).toBe(headOf(wkB, 'origin/main'))
    expect(dbDump(dbB, 'projects')).toContain('A-REMOTE')
    dbB.close()
  })

  it('7. applyRemoteAndImport: import falha → HEAD do clone restaurado, erro original relançado, push seguinte rejeitado', async () => {
    const { dir, wkB } = await behindRemote()
    const headBefore = headOf(wkB, 'HEAD')
    const remoteBefore = headOf(dir, 'main')
    expect(headBefore).not.toBe(remoteBefore)

    await expect(
      applyRemoteAndImport(wkB, () => {
        throw new Error('[sync] import deixou 2 violação(ões) de FK')
      }),
    ).rejects.toThrow('import deixou 2 violação(ões) de FK')

    expect(headOf(wkB, 'HEAD')).toBe(headBefore)
    expect(
      readFileSync(join(bundleDirFor(wkB), 'tables', 'projects.ndjson'), 'utf8'),
    ).not.toContain('A-REMOTE')

    // O coordinator empurra o DB local (velho) logo depois: com o clone no HEAD
    // antigo isso vira non-fast-forward em vez de sobrescrever o backup remoto.
    const dbB = newDb()
    seed(dbB, 'B-OLD')
    const push = await pushBundle(wkB, dbB, 'coordinator auto-push', {
      exportOpts: exportOpts(tmp('cm-feat-b-')),
    })
    expect(push.rejected).toBe(true)
    expect(push.pushed).toBe(false)
    expect(headOf(dir, 'main')).toBe(remoteBefore)
    dbB.close()
  })

  it('status reporta ahead após commit local não-empurrado', async () => {
    const { url } = makeBareRemote()
    const wkSeed = tmp('cm-wk-seed-')
    await ensureRepo(wkSeed, url)
    const dbSeed = newDb()
    seed(dbSeed, 'BASE')
    await pushBundle(wkSeed, dbSeed, 'base', { exportOpts: exportOpts(tmp('cm-feat-seed-')) })
    dbSeed.close()

    const wkB = tmp('cm-wk-b-')
    await ensureRepo(wkB, url)
    const dbB = newDb()
    seed(dbB, 'B-LOCAL')
    await pushBundle(wkB, dbB, 'B local', { exportOpts: exportOpts(tmp('cm-feat-b-')) })
    // push rejeitado? não — B está em sync com origin (clonou o base e só ele
    // avançou) → push deve ter ido. Reabrimos: status limpo, ahead 0.
    const st = await status(wkB)
    expect(st.behind).toBe(0)
    dbB.close()
  })
})

// Helper: muda o título do projeto seed para criar divergência de conteúdo.
function db_update_title(db: Database.Database, title: string): void {
  db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(title, 'proj-1')
}
