/** @vitest-environment node */
// "Encerrada pelo usuário" de ponta a ponta no main, contra os produtores reais:
// SQLite com as migrations do app, handoff-store de verdade, os handlers que
// registerHandoffsIpc/registerSessionIpc registram (inclusive o de exit da PTY) e
// o handoff-wake real. Fakes só na borda: a PTY, a fila de prompts e o disco do
// transcript (HOME temporário).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../services/migrations/index'

const { HOME } = vi.hoisted(() => ({
  HOME: `${process.env.TMPDIR ?? '/tmp'}/cm-child-ended-${process.pid}-${Date.now()}`,
}))

const seam = vi.hoisted(() => ({
  db: null as unknown as import('better-sqlite3').Database,
  handlers: new Map<string, (event: unknown, ...args: never[]) => unknown>(),
  exitListeners: [] as Array<(e: { sessionId: string; exitCode: number }) => void>,
  spawns: [] as string[],
  live: new Set<string>(),
  broadcasts: [] as Array<{ channel: string; payload: unknown }>,
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
    on: () => {},
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
    on: (event: string, fn: (e: { sessionId: string; exitCode: number }) => void) => {
      if (event === 'exit') seam.exitListeners.push(fn)
    },
    off: () => {},
    write: () => {},
    isRunning: (id: string) => seam.live.has(id),
    runningIds: () => [...seam.live],
    getPid: () => null,
    sessionIdByPid: () => null,
    spawn: (opts: { sessionId: string }) => {
      seam.spawns.push(opts.sessionId)
      seam.live.add(opts.sessionId)
    },
  },
}))
vi.mock('./composer-drafts', async (orig) => ({
  ...(await orig<typeof import('./composer-drafts')>()),
  requestDraftFlush: async () => true,
}))
vi.mock('../services/custom-env', () => ({ sessionSpawnEnv: () => ({}) }))
vi.mock('../services/feature-memory', () => ({ featureMemory: { onSessionExit: () => {} } }))
vi.mock('../services/mcp/server', () => ({ getMcpRuntime: () => null }))
vi.mock('../services/mcp/config', () => ({
  mcpClientConfigPath: () => '/tmp/mcp.json',
  writeSessionMcpClientConfig: () => '/tmp/mcp-session.json',
  removeSessionMcpConfig: () => {},
}))
vi.mock('../services/notify', () => ({
  broadcast: (channel: string, payload: unknown) => {
    seam.broadcasts.push({ channel, payload })
  },
}))

import * as handoffStore from '../services/handoff-store'
import {
  __resetForTests as resetHandoffWake,
  setHandoffWakeQueue,
} from '../services/handoff/handoff-wake'
import type { Handoff } from '../../../shared/types/ipc'
import type { SendPromptInput } from '../../../shared/types/send-prompt'
import { registerHandoffsIpc } from './handoffs'
import { registerSessionIpc } from './sessions'

const CC = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const MOTHER_CC = '6f9619ff-8b86-d011-b42d-00c04fc964ff'
const REPO_DIR = join(HOME, 'repo')

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
       VALUES (?, 'r1', ?, ?, 'running', ?)`,
    )
    .run(id, cc, title, startedAt)
  seam.live.add(id)
}

// Mãe viva + filha viva vinculada por um handoff running, como o session_handoff
// deixa: create → markRunning.
function runningChild(): string {
  insertSession('mae', MOTHER_CC, 5, 'mae')
  insertSession('filha', CC, 10, 'filha-api')
  const h = handoffStore.create({
    targetRepoId: 'r1',
    task: 'tarefa',
    composedPrompt: 'p',
    motherSessionId: 'mae',
    status: 'approved',
  })
  return handoffStore.markRunning(h.id, 'filha').id
}

function setChildEnded(sessionId: string, ended: boolean): Handoff | null {
  return seam.handlers.get('handoffs:set-child-ended')!(null, {
    sessionId,
    ended,
  } as never) as Handoff | null
}

// O kill do endSession, visto do main: a PTY some e o ptyManager emite 'exit'.
function ptyExits(sessionId: string, exitCode = 0): void {
  seam.live.delete(sessionId)
  for (const fn of seam.exitListeners) fn({ sessionId, exitCode })
}

function captureWakes(): SendPromptInput[] {
  const sent: SendPromptInput[] = []
  setHandoffWakeQueue({
    send: async (input) => {
      sent.push(input)
      return { ok: true, delivered: true }
    },
    replaceText: () => true,
    cancel: () => true,
  })
  return sent
}

beforeEach(() => {
  seam.spawns.length = 0
  seam.broadcasts.length = 0
  seam.live.clear()
  seam.handlers.clear()
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(REPO_DIR, { recursive: true })
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
  registerHandoffsIpc()
})

afterEach(() => {
  resetHandoffWake()
  seam.db.close()
})

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true })
})

describe('handoffs:set-child-ended', () => {
  it('marca e desmarca a filha vinculada sem mexer em status nem vínculo', () => {
    const id = runningChild()

    const marked = setChildEnded('filha', true)
    expect(marked).toMatchObject({ id, status: 'running', childSessionId: 'filha' })
    expect(marked?.endedByUserAt).toEqual(expect.any(Number))
    expect(seam.broadcasts.at(-1)).toMatchObject({
      channel: 'handoff:updated',
      payload: { id, endedByUserAt: marked?.endedByUserAt },
    })

    const cleared = setChildEnded('filha', false)
    expect(cleared).toMatchObject({ id, status: 'running', childSessionId: 'filha' })
    expect(cleared?.endedByUserAt).toBeNull()
  })

  it('outra linha da mesma conversa (resume fora do relink) marca o handoff da conversa', () => {
    const id = runningChild()
    insertSession('filha-linha-nova', CC, 20)

    expect(setChildEnded('filha-linha-nova', true)?.id).toBe(id)
    expect(handoffStore.get(id)?.endedByUserAt).not.toBeNull()
  })

  it('sessão comum, mãe ou filha já solta: não faz nada', () => {
    const id = runningChild()
    insertSession('comum', '11111111-2222-3333-4444-555555555555', 30)

    expect(setChildEnded('comum', true)).toBeNull()
    expect(setChildEnded('mae', true)).toBeNull()
    handoffStore.release(id)
    expect(setChildEnded('filha', true)).toBeNull()
    expect(handoffStore.get(id)?.endedByUserAt).toBeNull()
  })
})

describe('exit da PTY de uma filha encerrada pelo usuário', () => {
  it('handoff vira interrupted com o motivo do usuário, segue vinculado, e o aviso à mãe diz isso', async () => {
    const id = runningChild()
    const sent = captureWakes()
    setChildEnded('filha', true)

    ptyExits('filha')

    const after = handoffStore.get(id)
    expect(after).toMatchObject({ status: 'interrupted', childSessionId: 'filha', resumable: true })
    expect(after?.endedByUserAt).not.toBeNull()
    expect(after?.error).toMatch(/encerrada pelo usuário/i)
    expect(after?.error).not.toMatch(/handoff_report/)

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].sessionId).toBe('mae')
    expect(sent[0].text).toMatch(/reason="interrupted"/)
    expect(sent[0].text).toMatch(/encerrada pelo usuário/i)
    expect(sent[0].text).toMatch(/não re-despache/i)
  })

  it('sem a marca (a filha caiu sozinha) segue o motivo de sempre', async () => {
    const id = runningChild()
    const sent = captureWakes()

    ptyExits('filha', 1)

    expect(handoffStore.get(id)?.error).toMatch(/sem chamar handoff_report/)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].text).not.toMatch(/encerrada pelo usuário/i)
  })

  it('desfeito antes do kill: a marca não fica e um exit posterior é o de sempre', () => {
    const id = runningChild()
    setChildEnded('filha', true)
    setChildEnded('filha', false)

    ptyExits('filha', 1)

    expect(handoffStore.get(id)).toMatchObject({ status: 'interrupted', endedByUserAt: null })
    expect(handoffStore.get(id)?.error).toMatch(/sem chamar handoff_report/)
  })
})

describe('retomar uma filha encerrada pelo usuário limpa a marca', () => {
  it('handoffs:resume: volta a running no MESMO handoff, com a filha nova apontada', () => {
    const id = runningChild()
    setChildEnded('filha', true)
    ptyExits('filha')

    const resumed = seam.handlers.get('handoffs:resume')!(null, id as never) as Handoff

    expect(seam.spawns).toHaveLength(1)
    expect(resumed).toMatchObject({ id, status: 'running', childSessionId: seam.spawns[0] })
    expect(handoffStore.get(id)?.endedByUserAt).toBeNull()
    expect(handoffStore.get(id)?.motherSessionId).toBe('mae')
  })

  it('filha done encerrada: retomar limpa a marca e o handoff segue done', () => {
    const id = runningChild()
    handoffStore.report(id, 'entregue')
    setChildEnded('filha', true)
    ptyExits('filha')
    expect(handoffStore.get(id)).toMatchObject({ status: 'done', childSessionId: 'filha' })
    expect(handoffStore.get(id)?.endedByUserAt).not.toBeNull()

    seam.handlers.get('handoffs:resume')!(null, id as never)

    expect(seam.spawns).toHaveLength(1)
    expect(handoffStore.get(id)).toMatchObject({
      status: 'done',
      childSessionId: seam.spawns[0],
      endedByUserAt: null,
    })
  })

  it('retomada com a PTY ainda viva (janela do Desfazer): sem spawn, e a marca sai', () => {
    const id = runningChild()
    setChildEnded('filha', true)

    seam.handlers.get('handoffs:resume')!(null, id as never)

    expect(seam.spawns).toEqual([])
    expect(handoffStore.get(id)).toMatchObject({
      status: 'running',
      childSessionId: 'filha',
      endedByUserAt: null,
    })
  })
})
