/** @vitest-environment node */
// Guardas do resume contra os produtores reais: SQLite com as migrations do app,
// handoffs escritos pelo handoff-store, e o índice ~/.claude/sessions/<pid>.json
// lido do disco por buildSessionsFileIndex (HOME temporário). O processo "de fora"
// é um `sleep` de verdade, com o pid no arquivo do índice.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  // pid de cada PTY "viva" (sessions.id → pid), como o ptyManager real expõe.
  pids: new Map<string, number>(),
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
    getPid: (id: string) => (seam.live.has(id) ? (seam.pids.get(id) ?? null) : null),
    sessionIdByPid: (pid: number) =>
      [...seam.pids].find(([id, p]) => p === pid && seam.live.has(id))?.[0] ?? null,
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
import { foreignHolderPid, openElsewhereReason } from '../services/conversation-holder'
import {
  __resetForTests as resetHandoffWake,
  insertRow,
  redeliverFailedWakes,
  setHandoffWakeQueue,
} from '../services/handoff/handoff-wake'
import type { SendPromptInput } from '../../../shared/types/send-prompt'
import { registerSessionIpc, setResumedSessionHook } from './sessions'

const CC = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const REPO_DIR = join(HOME, 'repo')
const SESSIONS_DIR = join(HOME, '.claude', 'sessions')

let foreign: ChildProcess | null = null
const ownPtys: ChildProcess[] = []

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

// Campo 22 de /proc/<pid>/stat: o que o Claude Code grava em procStart.
function procStartOf(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
}

// O arquivo que o Claude Code escreve por processo vivo (formato do 2.1.295:
// procStart = start time do próprio processo). procStart: 'real' = o do processo,
// null = arquivo de versão antiga, string = outro processo (pid reciclado).
function holdConversationInForeignProcess(
  cc: string,
  opts: { procStart?: 'real' | null | string; argv0?: string } = {},
): number {
  foreign = spawn('sleep', ['30'], { stdio: 'ignore', argv0: opts.argv0 })
  const pid = foreign.pid!
  const mode = opts.procStart === undefined ? 'real' : opts.procStart
  const procStart = mode === 'real' ? procStartOf(pid) : mode
  writeFileSync(
    join(SESSIONS_DIR, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: cc,
      cwd: REPO_DIR,
      status: 'idle',
      updatedAt: Date.now(),
      ...(procStart === null ? {} : { procStart }),
    }),
  )
  return pid
}

function resumeResult(cc = CC): { session: { id: string }; reattached: boolean } {
  return seam.handlers.get('sessions:resume')!(null, {
    repoId: 'r1',
    ccSessionId: cc,
  } as never) as { session: { id: string }; reattached: boolean }
}

// PTY do Pitwall (linha `id`) com um processo de verdade; o índice diz em que
// conversa o pid dela está agora (o claude reescreve o próprio <pid>.json no /clear).
function pitwallPty(id: string, indexedCc: string | null): number {
  const proc = spawn('sleep', ['30'], { stdio: 'ignore' })
  ownPtys.push(proc)
  const pid = proc.pid!
  seam.live.add(id)
  seam.pids.set(id, pid)
  if (indexedCc) {
    writeFileSync(
      join(SESSIONS_DIR, `${pid}.json`),
      JSON.stringify({ pid, sessionId: indexedCc, status: 'idle', procStart: procStartOf(pid) }),
    )
  }
  return pid
}

function resume(): { id: string } {
  return resumeResult().session
}

beforeEach(() => {
  seam.spawns.length = 0
  seam.live.clear()
  seam.pids.clear()
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
  for (const proc of ownPtys.splice(0)) proc.kill()
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

  it('pid reciclado (vivo, mas procStart de outro processo) não bloqueia o resume', () => {
    insertSession('old', CC, 10)
    const pid = holdConversationInForeignProcess(CC, { procStart: '1' })
    expect(procStartOf(pid)).not.toBe('1')

    expect(foreignHolderPid(CC)).toBeNull()
    resume()
    expect(seam.spawns).toHaveLength(1)
  })

  it('arquivo sem procStart: só bloqueia se o cmdline do pid for de um claude', () => {
    insertSession('old', CC, 10)
    holdConversationInForeignProcess(CC, { procStart: null })
    expect(foreignHolderPid(CC)).toBeNull()
    foreign?.kill()

    const pid = holdConversationInForeignProcess(CC, { procStart: null, argv0: 'claude' })
    expect(foreignHolderPid(CC)).toBe(pid)
    expect(() => resume()).toThrow(`conversa aberta em outro processo (pid ${pid})`)
    expect(seam.spawns).toEqual([])
  })

  it('fora do Linux (sem procStart verificável) não recusa: loga e spawna', () => {
    insertSession('old', CC, 10)
    const pid = holdConversationInForeignProcess(CC)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let warned: string[] = []
    try {
      for (const os of ['darwin', 'win32']) {
        Object.defineProperty(process, 'platform', { ...platform, value: os })
        expect(foreignHolderPid(CC)).toBeNull()
      }
      resume()
      warned = warn.mock.calls.map((c) => String(c[0]))
    } finally {
      Object.defineProperty(process, 'platform', platform)
      warn.mockRestore()
    }

    expect(seam.spawns).toHaveLength(1)
    expect(warned).toContainEqual(
      expect.stringContaining(`"event":"conversation_holder_unverified","pid":${pid}`),
    )
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
      openElsewhere: openElsewhereReason,
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

describe('PTY do Pitwall que mudou de conversa na TUI (/clear, /resume)', () => {
  const OTHER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d'

  it('o índice diz que o pid está em outra conversa: não reanexa, spawna o resume', () => {
    insertSession('a', CC, 10)
    pitwallPty('a', OTHER)

    const { session, reattached } = resumeResult()

    expect(reattached).toBe(false)
    expect(seam.spawns).toEqual([session.id])
  })

  it('o índice confirma a conversa: reanexa sem spawn', () => {
    insertSession('a', CC, 10)
    pitwallPty('a', CC)

    expect(resumeResult()).toMatchObject({ session: { id: 'a' }, reattached: true })
    expect(seam.spawns).toEqual([])
  })

  it('pid ausente do índice (claude subindo, Windows): vale a linha, reanexa', () => {
    insertSession('a', CC, 10)
    pitwallPty('a', null)

    expect(resumeResult()).toMatchObject({ session: { id: 'a' }, reattached: true })
  })

  it('retomar a conversa para onde a aba foi: recusa dizendo que é uma aba do Pitwall', () => {
    insertSession('a', CC, 10)
    const pid = pitwallPty('a', OTHER)

    expect(() => resumeResult(OTHER)).toThrow(
      `conversa aberta em outra aba do Pitwall (pid ${pid})`,
    )
    expect(seam.spawns).toEqual([])
  })

  it('linha movida não conta como dona: um claude de fora com a conversa ainda recusa', () => {
    insertSession('a', CC, 10)
    pitwallPty('a', OTHER)
    const pid = holdConversationInForeignProcess(CC)

    expect(() => resume()).toThrow(`conversa aberta em outro processo (pid ${pid})`)
    expect(seam.spawns).toEqual([])
  })
})

describe('hook de sessão retomada (reenvio dos wake_failed)', () => {
  afterEach(() => setResumedSessionHook(() => {}))

  it('dispara com o id novo quando o resume spawna, e não no re-attach', () => {
    const resumed: string[] = []
    setResumedSessionHook((session) => resumed.push(session.id))
    insertSession('old', CC, 10)

    const { session } = resumeResult()
    expect(resumed).toEqual([session.id])

    expect(resumeResult().reattached).toBe(true)
    expect(resumed).toEqual([session.id])
  })

  it("origem: sessions:resume (inclusive o relink) é 'renderer'; handoffs:resume é 'main'", () => {
    const origins: Array<[string, string]> = []
    setResumedSessionHook((session, origin) => origins.push([session.id, origin]))
    const { h1 } = childThatIsAlsoMother()

    const viaSwitcher = resumeResult().session.id
    seam.live.clear()
    seam.handlers.get('handoffs:resume')!(null, h1 as never)
    const viaPanel = seam.spawns[1]

    expect(origins).toEqual([
      [viaSwitcher, 'renderer'],
      [viaPanel, 'main'],
    ])
  })
})

describe('sessions:resume da filha de handoff (ramo linked)', () => {
  it('a liderança que a filha tinha como mãe passa para a sessão retomada', () => {
    insertSession('c-old', CC, 10, 'filha-api')
    const repo2 = join(HOME, 'repo2')
    mkdirSync(repo2)
    seam.db
      .prepare(
        `INSERT INTO repos (id, project_id, label, path, position, created_at)
         VALUES ('r2','p1','Repo 2',?,0,1)`,
      )
      .run(repo2)
    // H1: C é a filha (interrompida, retomável). H2: C é a mãe de outra filha.
    const h1 = handoffStore.create({
      targetRepoId: 'r1',
      task: 'h1',
      composedPrompt: 'p',
      motherSessionId: null,
      status: 'approved',
    })
    handoffStore.markRunning(h1.id, 'c-old')
    handoffStore.failIfRunning(h1.id, 'caiu')
    insertSession('grandchild', '6f9619ff-8b86-d011-b42d-00c04fc964ff', 5)
    const h2 = handoffStore.create({
      targetRepoId: 'r2',
      task: 'h2',
      composedPrompt: 'p',
      motherSessionId: 'c-old',
      status: 'approved',
    })
    handoffStore.markRunning(h2.id, 'grandchild')

    const { session, reattached } = resumeResult()

    expect(reattached).toBe(false)
    expect(seam.spawns).toEqual([session.id])
    expect(handoffStore.get(h1.id)?.childSessionId).toBe(session.id)
    const row = seam.db
      .prepare('SELECT mother_session_id FROM handoffs WHERE id = ?')
      .get(h2.id) as { mother_session_id: string }
    expect(row.mother_session_id).toBe(session.id)
  })
})

// H1: C é a filha (interrompida, retomável). H2: C é a mãe de outra filha (r2).
function childThatIsAlsoMother(): { h1: string; h2: string } {
  insertSession('c-old', CC, 10, 'filha-api')
  const repo2 = join(HOME, 'repo2')
  mkdirSync(repo2, { recursive: true })
  seam.db
    .prepare(
      `INSERT OR IGNORE INTO repos (id, project_id, label, path, position, created_at)
       VALUES ('r2','p1','Repo 2',?,0,1)`,
    )
    .run(repo2)
  const h1 = handoffStore.create({
    targetRepoId: 'r1',
    task: 'h1',
    composedPrompt: 'p',
    motherSessionId: null,
    status: 'approved',
  })
  handoffStore.markRunning(h1.id, 'c-old')
  handoffStore.failIfRunning(h1.id, 'caiu')
  insertSession('grandchild', '6f9619ff-8b86-d011-b42d-00c04fc964ff', 5)
  const h2 = handoffStore.create({
    targetRepoId: 'r2',
    task: 'h2',
    composedPrompt: 'p',
    motherSessionId: 'c-old',
    status: 'approved',
  })
  handoffStore.markRunning(h2.id, 'grandchild')
  return { h1: h1.id, h2: h2.id }
}

function motherOf(handoffId: string): string {
  return (
    seam.db.prepare('SELECT mother_session_id FROM handoffs WHERE id = ?').get(handoffId) as {
      mother_session_id: string
    }
  ).mother_session_id
}

describe('handoffs:resume (resumeHandoffChild)', () => {
  afterEach(() => {
    setResumedSessionHook(() => {})
    resetHandoffWake()
  })

  it('outra linha do mesmo cc com PTY viva: relink para ela, alreadyRunning, sem spawn', () => {
    const { h1 } = childThatIsAlsoMother()
    insertSession('c-live', CC, 20, 'filha-api')
    seam.live.add('c-live')

    const updated = seam.handlers.get('handoffs:resume')!(null, h1 as never) as {
      status: string
      childSessionId: string
    }

    expect(seam.spawns).toEqual([])
    expect(updated).toMatchObject({ status: 'running', childSessionId: 'c-live' })
    expect(handoffStore.get(h1)?.childSessionId).toBe('c-live')
  })

  it('sessions:resume do mesmo cc com outra linha viva também é re-attach', () => {
    insertSession('c-old', CC, 10)
    insertSession('c-live', CC, 20)
    seam.live.add('c-live')

    expect(resumeResult()).toMatchObject({ session: { id: 'c-live' }, reattached: true })
    expect(seam.spawns).toEqual([])
  })

  it('spawnou: transfere a liderança e reenvia os wake_failed da mãe para o id novo', async () => {
    const { h1, h2 } = childThatIsAlsoMother()
    // A filha de H2 reportou enquanto C (a mãe) dormia e o wake falhou.
    insertRow({
      wakeId: 'w-1',
      handoffId: h2,
      mother: 'c-old',
      reason: 'reported',
      outcome: 'wake_failed',
      detail: 'no-window',
    })
    const sent: SendPromptInput[] = []
    setHandoffWakeQueue({
      send: async (input) => {
        sent.push(input)
        return seam.live.has(input.sessionId)
          ? { ok: true, delivered: true }
          : { ok: false, error: 'not-running' }
      },
      replaceText: () => true,
      cancel: () => true,
    })
    const redelivered: Array<Promise<number>> = []
    setResumedSessionHook((session) => redelivered.push(redeliverFailedWakes(session.id)))

    seam.handlers.get('handoffs:resume')!(null, h1 as never)
    const resumedId = seam.spawns[0]
    await Promise.all(redelivered)

    expect(seam.spawns).toHaveLength(1)
    expect(handoffStore.get(h1)?.childSessionId).toBe(resumedId)
    expect(motherOf(h2)).toBe(resumedId)
    expect(sent.map((i) => i.sessionId)).toEqual([resumedId])
    const last = seam.db
      .prepare(
        `SELECT outcome, mother_session_id FROM handoff_wake_deliveries
          WHERE handoff_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(h2) as { outcome: string; mother_session_id: string }
    expect(last).toEqual({ outcome: 'delivered', mother_session_id: resumedId })
  })
})
