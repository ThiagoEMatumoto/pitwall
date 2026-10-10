/** @vitest-environment node */
// Guardas do resume contra os produtores reais: SQLite com as migrations do app,
// handoffs escritos pelo handoff-store, e o índice ~/.claude/sessions/<pid>.json
// lido do disco por buildSessionsFileIndex (HOME temporário). O processo "de fora"
// é um `sleep` de verdade, com o pid no arquivo do índice.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../services/migrations/index'

const { HOME } = vi.hoisted(() => ({
  HOME: `${process.env.TMPDIR ?? '/tmp'}/cm-resume-guards-${process.pid}-${Date.now()}`,
}))

const seam = vi.hoisted(() => ({
  db: null as unknown as import('better-sqlite3').Database,
  handlers: new Map<string, (event: unknown, ...args: never[]) => unknown>(),
  spawns: [] as string[],
  live: new Set<string>(),
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => HOME }
})
vi.mock('electron', () => ({
  app: { getPath: () => `${HOME}/userdata`, getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: never[]) => unknown) => {
      seam.handlers.set(channel, fn)
    },
  },
}))
vi.mock('chokidar', () => ({
  default: { watch: () => ({ on: () => {}, close: async () => {} }) },
}))
vi.mock('../services/db', () => ({
  getDb: () => seam.db,
  handoffsInterruptedAtOpen: () => [],
}))
vi.mock('../services/pty-manager', () => ({
  ptyManager: {
    on: () => {},
    off: () => {},
    write: () => {},
    isRunning: (id: string) => seam.live.has(id),
    runningIds: () => [...seam.live],
    spawn: (opts: { sessionId: string }) => {
      seam.spawns.push(opts.sessionId)
      seam.live.add(opts.sessionId)
    },
  },
}))
vi.mock('../services/custom-env', () => ({ sessionSpawnEnv: () => ({}) }))
vi.mock('../services/feature-memory', () => ({ featureMemory: { onSessionExit: () => {} } }))
vi.mock('../services/mcp/server', () => ({ getMcpRuntime: () => null }))
vi.mock('../services/mcp/config', () => ({
  mcpClientConfigPath: () => '/tmp/mcp.json',
  writeSessionMcpClientConfig: () => '/tmp/mcp-session.json',
  removeSessionMcpConfig: () => {},
}))
vi.mock('../services/notify', () => ({ broadcast: () => {} }))

import * as handoffStore from '../services/handoff-store'
import { DormantPanes } from '../services/dormant-panes'
import { foreignHolderPid } from '../services/conversation-holder'
import { registerSessionIpc } from './sessions'

const CC = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const REPO_DIR = join(HOME, 'repo')
const SESSIONS_DIR = join(HOME, '.claude', 'sessions')

let foreign: ChildProcess | null = null

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

function insertSession(id: string, cc: string, startedAt: number, title: string | null = null) {
  seam.db
    .prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, title, status, started_at)
       VALUES (?, 'r1', ?, ?, 'exited', ?)`,
    )
    .run(id, cc, title, startedAt)
}

// O arquivo que o Claude Code escreve por processo vivo.
function holdConversationInForeignProcess(cc: string): number {
  foreign = spawn('sleep', ['30'], { stdio: 'ignore' })
  const pid = foreign.pid!
  writeFileSync(
    join(SESSIONS_DIR, `${pid}.json`),
    JSON.stringify({ pid, sessionId: cc, cwd: REPO_DIR, status: 'idle', updatedAt: Date.now() }),
  )
  return pid
}

function resume(): { id: string } {
  return seam.handlers.get('sessions:resume')!(null, {
    repoId: 'r1',
    ccSessionId: CC,
  } as never) as { id: string }
}

beforeEach(() => {
  seam.spawns.length = 0
  seam.live.clear()
  seam.handlers.clear()
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(REPO_DIR, { recursive: true })
  mkdirSync(SESSIONS_DIR, { recursive: true })
  mkdirSync(join(HOME, '.claude', 'projects', 'p'), { recursive: true })
  writeFileSync(join(HOME, '.claude', 'projects', 'p', `${CC}.jsonl`), '')
  seam.db = new Database(':memory:')
  seam.db.pragma('foreign_keys = ON')
  applyAllMigrations(seam.db)
  seam.db
    .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',1,1)`)
    .run()
  seam.db
    .prepare(
      `INSERT INTO repos (id, project_id, label, path, position, created_at)
       VALUES ('r1','p1','Repo 1',?,0,1)`,
    )
    .run(REPO_DIR)
  registerSessionIpc()
})

afterEach(() => {
  foreign?.kill()
  foreign = null
  seam.db.close()
})

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true })
})

describe('resume com a conversa aberta fora do Pitwall', () => {
  it('sessions:resume recusa com o pid e não spawna', () => {
    insertSession('old', CC, 10)
    const pid = holdConversationInForeignProcess(CC)

    expect(() => resume()).toThrow(`conversa aberta em outro processo (pid ${pid})`)
    expect(seam.spawns).toEqual([])
  })

  it('pid do índice já morto não bloqueia o resume', async () => {
    insertSession('old', CC, 10)
    holdConversationInForeignProcess(CC)
    const exited = new Promise((resolve) => foreign!.once('exit', resolve))
    foreign!.kill()
    await exited

    resume()

    expect(seam.spawns).toHaveLength(1)
  })

  it('a conversa com PTY do próprio Pitwall é re-attach, não recusa', () => {
    insertSession('mine', CC, 10)
    seam.live.add('mine')
    holdConversationInForeignProcess(CC)

    expect(foreignHolderPid(CC)).toBeNull()
    expect(resume().id).toBe('mine')
    expect(seam.spawns).toEqual([])
  })

  it('handoffs:resume (resumeHandoffChild) recusa e o handoff segue interrupted', () => {
    insertSession('child-old', CC, 10, 'filha-api')
    const h = handoffStore.create({
      targetRepoId: 'r1',
      task: 't',
      composedPrompt: 'p',
      motherSessionId: null,
      status: 'approved',
    })
    handoffStore.markRunning(h.id, 'child-old')
    handoffStore.failIfRunning(h.id, 'caiu')
    const pid = holdConversationInForeignProcess(CC)

    expect(() => seam.handlers.get('handoffs:resume')!(null, h.id as never)).toThrow(
      `conversa aberta em outro processo (pid ${pid})`,
    )
    expect(seam.spawns).toEqual([])
    expect(handoffStore.get(h.id)?.status).toBe('interrupted')
  })

  it('wakeDormant falha com o motivo, sem pedir o resume ao renderer', async () => {
    const pid = holdConversationInForeignProcess(CC)
    const requestWake = vi.fn(() => true)
    const warn = vi.fn()
    const panes = new DormantPanes({
      requestWake,
      isRunning: () => false,
      screen: async () => null,
      warn,
      foreignHolderPid,
    })
    panes.setDormant([{ ccSessionId: CC, paneId: 'pane-1', title: 'api', repoId: 'r1' }])

    const outcome = await panes.wakeDormant(CC, 'handoff-wake')

    expect(outcome).toEqual({
      ok: false,
      error: `conversa aberta em outro processo (pid ${pid})`,
      sessionId: null,
    })
    expect(requestWake).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'dormant_wake_failed' }))
  })
})
