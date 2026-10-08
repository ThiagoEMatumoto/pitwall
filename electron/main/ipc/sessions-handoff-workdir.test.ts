/** @vitest-environment node */
// O cwd da filha de handoff no spawn é o work_dir gravado no create (a chave da
// posse), não o worktree recalculado na hora do spawn. Banco SQLite real e
// handoff-store real: o work_dir é escrito pelo produtor (create), não por fixture.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../services/migrations/index'

let testDb: Database.Database
vi.mock('../services/db', () => ({ getDb: () => testDb }))
vi.mock('../services/transcript-path', () => ({ findTranscriptPath: () => null }))

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'cm-test-userdata') },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}))

const spawns: Array<{ cwd: string; innerCmd: string }> = []
vi.mock('../services/pty-manager', () => ({
  ptyManager: {
    on: () => {},
    off: () => {},
    write: () => {},
    isRunning: () => false,
    runningIds: () => [],
    spawn: (opts: { args: string[]; cwd: string }) => {
      spawns.push({ cwd: opts.cwd, innerCmd: opts.args.join(' ') })
    },
  },
}))
vi.mock('../services/custom-env', () => ({ sessionSpawnEnv: () => ({}) }))
vi.mock('../services/feature-store', () => ({ get: () => null, linkedObjectiveTitles: () => [] }))
vi.mock('../services/feature-memory', () => ({ featureMemory: { onSessionExit: () => {} } }))
vi.mock('../services/mcp/server', () => ({ getMcpRuntime: () => null }))
vi.mock('../services/mcp/config', () => ({
  mcpClientConfigPath: () => '/tmp/mcp.json',
  writeSessionMcpClientConfig: () => '/tmp/mcp.json',
  removeSessionMcpConfig: () => {},
}))
vi.mock('../services/notify', () => ({ broadcast: () => {} }))

import * as handoffStore from '../services/handoff-store'
import { spawnSession } from './sessions'

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

describe('spawnSession — cwd da filha vem do work_dir do create', () => {
  let root: string
  let repoDir: string
  let wtA: string
  let wtB: string

  beforeEach(() => {
    spawns.length = 0
    root = mkdtempSync(join(tmpdir(), 'handoff-workdir-'))
    repoDir = join(root, 'repo')
    wtA = join(repoDir, '.worktrees', 'a')
    wtB = join(repoDir, '.worktrees', 'b')
    for (const d of [wtA, wtB]) mkdirSync(d, { recursive: true })

    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    const now = Date.now()
    testDb
      .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)`)
      .run(now, now)
    testDb
      .prepare(
        `INSERT INTO repos (id, project_id, label, path, position, created_at)
         VALUES ('r1','p1','Repo 1',?,0,?)`,
      )
      .run(repoDir, now)
    testDb
      .prepare(
        `INSERT INTO features (id, project_id, slug, title, status, doc_path, created_at, updated_at)
         VALUES ('f1','p1','f1','F1','in-progress','/tmp/f1.md',?,?)`,
      )
      .run(now, now)
    testDb
      .prepare('INSERT INTO feature_repos (feature_id, repo_id, worktree_path) VALUES (?, ?, ?)')
      .run('f1', 'r1', wtA)
  })

  afterEach(() => {
    testDb.close()
    rmSync(root, { recursive: true, force: true })
  })

  function createHandoff(mode: 'auto-edits' | 'plan' = 'auto-edits') {
    return handoffStore.create({
      targetRepoId: 'r1',
      featureId: 'f1',
      task: 't',
      composedPrompt: 'p',
      mode,
    })
  }

  function setWorktree(path: string): void {
    testDb
      .prepare('UPDATE feature_repos SET worktree_path = ? WHERE feature_id = ? AND repo_id = ?')
      .run(path, 'f1', 'r1')
  }

  it('feature_repos alterado entre create e spawn: sobe no diretório que possui', () => {
    const h = createHandoff()
    expect(handoffStore.workDirOf(h.id)).toBe(wtA)
    setWorktree(wtB)

    spawnSession({
      repoId: 'r1',
      featureId: 'f1',
      name: 'filha',
      permissionMode: 'acceptEdits',
      handoffChild: true,
      handoffId: h.id,
    })

    expect(spawns[0].cwd).toBe(wtA)
  })

  it('sem handoffId segue a regra do worktree atual (sessão comum)', () => {
    createHandoff()
    setWorktree(wtB)
    spawnSession({ repoId: 'r1', featureId: 'f1', name: 's' })
    expect(spawns[0].cwd).toBe(wtB)
  })

  it('work_dir removido do disco: cai na raiz e a posse acompanha', () => {
    const h = createHandoff()
    rmSync(wtA, { recursive: true, force: true })
    spawnSession({
      repoId: 'r1',
      featureId: 'f1',
      name: 'filha',
      permissionMode: 'acceptEdits',
      handoffChild: true,
      handoffId: h.id,
    })
    expect(spawns[0].cwd).toBe(repoDir)
    expect(handoffStore.workDirOf(h.id)).toBe(repoDir)
  })

  it('work_dir removido e a raiz já tem outra filha que escreve: recusa sem PTY', () => {
    const h = createHandoff()
    setWorktree('')
    const other = createHandoff()
    expect(handoffStore.workDirOf(other.id)).toBe(repoDir)
    rmSync(wtA, { recursive: true, force: true })

    expect(() =>
      spawnSession({
        repoId: 'r1',
        featureId: 'f1',
        name: 'filha',
        permissionMode: 'acceptEdits',
        handoffChild: true,
        handoffId: h.id,
      }),
    ).toThrow(/não existe mais.*outra filha que escreve/)
    expect(spawns).toHaveLength(0)
    expect(handoffStore.workDirOf(h.id)).toBe(wtA)
  })

  it('filha plan recebe o deny de escrita no --settings', () => {
    const h = createHandoff('plan')
    spawnSession({
      repoId: 'r1',
      featureId: 'f1',
      name: 'revisora',
      permissionMode: 'plan',
      handoffChild: true,
      handoffId: h.id,
    })
    expect(spawns[0].innerCmd).toContain('"Edit","Write","NotebookEdit"')
  })
})
