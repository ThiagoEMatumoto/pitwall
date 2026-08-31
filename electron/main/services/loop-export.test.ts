/** @vitest-environment node */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './migrations/index'

// Mesmo padrão de loop-store.test: getDb mockado pra um SQLite in-memory
// migrado. O disco é real (tmp dir) — o que se testa aqui é justamente onde o
// arquivo cai e quando ele NÃO é escrito.
let testDb: Database.Database
vi.mock('./db', () => ({
  getDb: () => testDb,
}))

import { exportLoopDoc } from './loop-export'
import * as store from './loop-store'

let root: string

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

function seedFeature(id: string, slug: string, opts?: { loopExport?: number }): void {
  const now = Date.now()
  testDb
    .prepare(
      `INSERT INTO features
         (id, project_id, slug, title, status, objective, doc_path, synth_mode, origin,
          loop_export, created_at, updated_at)
       VALUES (?, 'proj-1', ?, ?, 'in-progress', 'Fechar o loop: sem app', ?, 'threshold',
               'manual', ?, ?, ?)`,
    )
    .run(id, slug, `Feature ${slug}`, `/tmp/${slug}.md`, opts?.loopExport ?? 1, now, now)
}

function linkRepo(featureId: string, repoId: string, path: string, worktree?: string): void {
  testDb
    .prepare(
      'INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    )
    .run(repoId, 'proj-1', repoId, path, Date.now())
  testDb
    .prepare(
      'INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path) VALUES (?, ?, NULL, ?)',
    )
    .run(featureId, repoId, worktree ?? null)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loop-export-test-'))
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  applyAllMigrations(testDb)
  const now = Date.now()
  testDb
    .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('proj-1', 'Projeto de teste', now, now)
})

afterEach(() => {
  testDb.close()
  rmSync(root, { recursive: true, force: true })
})

describe('exportLoopDoc', () => {
  it('escreve .pitwall/loop-<slug>.md no repo vinculado, com pulso, ledger e métricas', async () => {
    const repo = join(root, 'repo-a')
    mkdirSync(repo, { recursive: true })
    seedFeature('feat-1', 'loop-demo')
    linkRepo('feat-1', 'repo-a', repo)
    store.setPulse('feat-1', 'Parser do ledger em pé; falta o export.', 'mcp')
    // Sem body a entrada nasce arquivada (semântica as-of do store) e sumiria do doc.
    store.appendLedger('feat-1', {
      featureId: 'feat-1',
      entryId: 'export',
      title: 'Export do doc',
      body: 'Escreve .pitwall/loop-<slug>.md em cada repo vinculado.',
    })
    store.declareMetric('feat-1', { featureId: 'feat-1', columnKey: 'p95', unit: 'ms', target: 100, isHeadline: true })
    store.recordMetricPoint('feat-1', 'p95', Date.now(), 98)

    const result = await exportLoopDoc('feat-1')

    const target = join(repo, '.pitwall', 'loop-loop-demo.md')
    expect(result.written).toEqual([target])
    expect(result.skipped).toEqual([])
    const doc = readFileSync(target, 'utf8')
    expect(doc).toContain('slug: "loop-demo"')
    expect(doc).toContain('liveness: alive')
    expect(doc).toContain('Parser do ledger em pé')
    expect(doc).toContain('`export`')
    expect(doc).toContain('tom: ok')
    // Nenhum carimbo de geração: o arquivo não pode sujar o diff do usuário.
    expect(doc).not.toMatch(/generated_at|generated at|exported_at/i)
  })

  it('duas exportações do mesmo estado produzem bytes idênticos', async () => {
    const repo = join(root, 'repo-b')
    mkdirSync(repo, { recursive: true })
    seedFeature('feat-1', 'estavel')
    linkRepo('feat-1', 'repo-b', repo)
    store.setPulse('feat-1', 'Estado congelado.', 'mcp')

    const target = join(repo, '.pitwall', 'loop-estavel.md')
    await exportLoopDoc('feat-1')
    const first = readFileSync(target, 'utf8')
    await exportLoopDoc('feat-1')
    const second = readFileSync(target, 'utf8')

    expect(second).toBe(first)
  })

  it('repo ausente no disco vira skipped e não cria diretório nenhum', async () => {
    const missing = join(root, 'sumiu')
    seedFeature('feat-1', 'orfa')
    linkRepo('feat-1', 'repo-c', missing)

    const result = await exportLoopDoc('feat-1')

    expect(result.written).toEqual([])
    expect(result.skipped).toEqual([
      { repoId: 'repo-c', reason: `repo não encontrado: ${missing}` },
    ])
    expect(existsSync(missing)).toBe(false)
  })

  it('slug que escaparia do repo é rejeitado sem escrever', async () => {
    const repo = join(root, 'repo-d')
    mkdirSync(repo, { recursive: true })
    seedFeature('feat-1', '../../../pwn')
    linkRepo('feat-1', 'repo-d', repo)

    const result = await exportLoopDoc('feat-1')

    expect(result.written).toEqual([])
    expect(result.skipped[0].repoId).toBe('repo-d')
    expect(result.skipped[0].reason).toContain('escaparia')
    // O caso que passava despercebido: `../..` cancela só o `.pitwall` e o
    // arquivo cairia na RAIZ do repo, ainda "dentro" dele.
    expect(existsSync(join(repo, 'pwn.md'))).toBe(false)
    expect(existsSync(join(repo, '.pitwall'))).toBe(false)
  })

  it('slug que sairia do próprio repo também é rejeitado', async () => {
    const repo = join(root, 'repo-g')
    mkdirSync(repo, { recursive: true })
    seedFeature('feat-1', '../../../../../pwn')
    linkRepo('feat-1', 'repo-g', repo)

    const result = await exportLoopDoc('feat-1')

    expect(result.written).toEqual([])
    expect(result.skipped[0].reason).toContain('escaparia')
    expect(existsSync(join(root, 'pwn.md'))).toBe(false)
  })

  it('loop_export = 0 não escreve nada', async () => {
    const repo = join(root, 'repo-e')
    mkdirSync(repo, { recursive: true })
    seedFeature('feat-1', 'mudo', { loopExport: 0 })
    linkRepo('feat-1', 'repo-e', repo)

    const result = await exportLoopDoc('feat-1')

    expect(result).toEqual({ written: [], skipped: [] })
    expect(existsSync(join(repo, '.pitwall'))).toBe(false)
  })

  it('worktree_path vence o path do repo, e dryRun não toca no disco', async () => {
    const repo = join(root, 'repo-f')
    const worktree = join(root, 'repo-f-wt')
    mkdirSync(repo, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    seedFeature('feat-1', 'wt')
    linkRepo('feat-1', 'repo-f', repo, worktree)

    const result = await exportLoopDoc('feat-1', { dryRun: true })

    expect(result.written).toEqual([join(worktree, '.pitwall', 'loop-wt.md')])
    expect(existsSync(join(worktree, '.pitwall'))).toBe(false)
  })

  it('feature inexistente falha alto', async () => {
    await expect(exportLoopDoc('nao-existe')).rejects.toThrow('feature not found')
  })
})
