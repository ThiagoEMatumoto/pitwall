/** @vitest-environment node */
// room:start-mother com banco SQLite real (todas as migrations) e o spawnSession
// real até o INSERT: só a PTY, o MCP e o transcript são stubados. A linha lida
// no fim é a que o produtor escreveu, e o grafo é o buildSessionGraph real.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../services/migrations/index'

let testDb: Database.Database
let userData: string
vi.mock('../services/db', () => ({ getDb: () => testDb }))
vi.mock('../services/transcript-path', () => ({ findTranscriptPath: () => null }))

vi.mock('electron', () => ({
  app: { getPath: () => userData },
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
vi.mock('../services/feature-memory', () => ({ featureMemory: { onSessionExit: () => {} } }))

const mcp = vi.hoisted(() => ({
  runtime: null as null | { port: number; url: string; token: string; close: () => Promise<void> },
}))
vi.mock('../services/mcp/server', () => ({ getMcpRuntime: () => mcp.runtime }))
vi.mock('../services/mcp/config', () => ({
  mcpClientConfigPath: () => '/tmp/mcp.json',
  writeSessionMcpClientConfig: () => '/tmp/mcp-session.json',
  removeSessionMcpConfig: () => {},
}))
const broadcasts: Array<{ channel: string; payload: unknown }> = []
vi.mock('../services/notify', () => ({
  broadcast: (channel: string, payload: unknown) => broadcasts.push({ channel, payload }),
  onBroadcast: () => () => {},
}))

import { buildSessionGraph, readSessionGraphInput } from '../services/session-graph'
import { MCP_NOT_READY, motherPreflight, startMother } from './room-mother'

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

const sessionCount = () =>
  (testDb.prepare('SELECT count(*) AS c FROM sessions').get() as { c: number }).c

describe('room:start-mother', () => {
  let root: string
  let repoDir: string
  let worktree: string

  beforeEach(() => {
    spawns.length = 0
    broadcasts.length = 0
    mcp.runtime = { port: 1, url: 'http://127.0.0.1:1/mcp', token: 't', close: async () => {} }
    root = mkdtempSync(join(tmpdir(), 'room-mother-'))
    userData = join(root, 'userData')
    repoDir = join(root, 'repo')
    worktree = join(repoDir, '.worktrees', 'f1')
    mkdirSync(worktree, { recursive: true })

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
        `INSERT INTO features (id, project_id, slug, title, status, objective, doc_path, created_at, updated_at)
         VALUES ('f1','p1','f1','Room da mãe','in-progress','Conversar com a mãe na Room',?,?,?)`,
      )
      .run(join(root, 'f1.md'), now, now)
    testDb
      .prepare('INSERT INTO feature_repos (feature_id, repo_id, worktree_path) VALUES (?, ?, ?)')
      .run('f1', 'r1', worktree)
  })

  afterEach(() => {
    testDb.close()
    rmSync(root, { recursive: true, force: true })
  })

  const input = { featureId: 'f1', repoId: 'r1', purpose: 'Fechar o PR A da Room' }

  it('grava feature_id, purpose e cc_session_id no ato, no worktree da feature', () => {
    const res = startMother(input)

    const row = testDb
      .prepare('SELECT feature_id, purpose, cc_session_id FROM sessions WHERE id = ?')
      .get(res.sessionId) as { feature_id: string; purpose: string; cc_session_id: string | null }
    expect(row.feature_id).toBe('f1')
    expect(row.purpose).toBe('Fechar o PR A da Room')
    // Bloqueador 1 do plano: o ccSessionId existe assim que o handler volta.
    expect(row.cc_session_id).not.toBeNull()
    expect(res.ccSessionId).toBe(row.cc_session_id)
    expect(res.ccSessionIdReadyMs).toBeGreaterThanOrEqual(0)
    expect(res.cwd).toBe(worktree)
    expect(spawns[0].cwd).toBe(worktree)
    expect(spawns[0].innerCmd).toContain('--mcp-config')
    expect(broadcasts).toContainEqual({ channel: 'room:changed', payload: { featureId: 'f1' } })

    // O que a Room vai ler: o nó do grafo real carrega featureId e purpose.
    const live = new Map([
      [res.sessionId, { status: 'idle' as const, lastActivityAt: null, name: null }],
    ])
    const graph = buildSessionGraph(readSessionGraphInput(testDb, live))
    const node = graph.nodes.find((n) => n.sessionId === res.sessionId)
    expect(node?.featureId).toBe('f1')
    expect(node?.purpose).toBe('Fechar o PR A da Room')
  })

  it('o system prompt traz o papel de mãe e o purpose DEPOIS do bloco da feature', () => {
    startMother(input)
    const path = /--append-system-prompt-file (\S+)/.exec(spawns[0].innerCmd)?.[1]
    expect(path).toBeTruthy()
    const prompt = readFileSync(path!.replace(/^'|'$/g, ''), 'utf8')
    const feature = prompt.indexOf('Esta sessão trabalha na feature «Room da mãe»')
    const role = prompt.indexOf('## Seu papel: sessão-mãe')
    expect(feature).toBeGreaterThanOrEqual(0)
    expect(role).toBeGreaterThan(feature)
    expect(prompt.slice(role)).toContain('Fechar o PR A da Room')
  })

  it('sem MCP: rejeita com MCP_NOT_READY e não cria sessão nem PTY', () => {
    mcp.runtime = null
    const before = sessionCount()
    expect(() => startMother(input)).toThrow(new RegExp(`^${MCP_NOT_READY}: .*Reinicie o Pitwall`))
    expect(sessionCount()).toBe(before)
    expect(spawns).toHaveLength(0)
  })

  it('purpose vazio ou só espaços: erro do zod, sem spawn', () => {
    expect(() => startMother({ ...input, purpose: '' })).toThrow()
    expect(() => startMother({ ...input, purpose: '   ' })).toThrow()
    expect(sessionCount()).toBe(0)
    expect(spawns).toHaveLength(0)
  })
})

describe('room:mother-preflight', () => {
  let root: string
  let worktree: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'room-mother-pf-'))
    userData = join(root, 'userData')
    worktree = join(root, 'repo', '.worktrees', 'f1')
    mkdirSync(worktree, { recursive: true })
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
         VALUES ('r1','p1','Repo 1',?,0,?), ('r2','p1','Sumido',?,1,?)`,
      )
      .run(join(root, 'repo'), now, join(root, 'nao-existe'), now)
    testDb
      .prepare(
        `INSERT INTO features (id, project_id, slug, title, status, doc_path, created_at, updated_at)
         VALUES ('f1','p1','f1','Só título','in-progress',?,?,?)`,
      )
      .run(join(root, 'f1.md'), now, now)
    testDb
      .prepare('INSERT INTO feature_repos (feature_id, repo_id, worktree_path) VALUES (?, ?, ?)')
      .run('f1', 'r1', worktree)
  })

  afterEach(() => {
    testDb.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('MCP ligado: repos da feature com worktree e purpose sugerido = título', () => {
    mcp.runtime = { port: 1, url: 'u', token: 't', close: async () => {} }
    const pf = motherPreflight('f1', 'r1')
    expect(pf).toMatchObject({
      featureExists: true,
      mcpReady: true,
      mcpBlockReason: null,
      suggestedPurpose: 'Só título',
      ccSessionIdAtSpawn: true,
    })
    expect(pf.repos).toEqual([
      { repoId: 'r1', label: 'Repo 1', valid: true, hasWorktree: true, cwd: worktree },
    ])
    expect(pf.repo?.hasWorktree).toBe(true)
  })

  it('MCP desligado traz o motivo; repo com diretório sumido é inválido', () => {
    mcp.runtime = null
    const pf = motherPreflight('f1', 'r2')
    expect(pf.mcpReady).toBe(false)
    expect(pf.mcpBlockReason).toMatch(/Reinicie o Pitwall/)
    expect(pf.repo).toMatchObject({ repoId: 'r2', valid: false, hasWorktree: false, cwd: null })
  })

  it('feature inexistente', () => {
    expect(motherPreflight('nope')).toMatchObject({
      featureExists: false,
      repos: [],
      repo: null,
      suggestedPurpose: null,
    })
  })
})
