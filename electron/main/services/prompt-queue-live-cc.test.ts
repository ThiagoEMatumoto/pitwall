/** @vitest-environment node */
// A linha sessions guarda o cc do spawn; depois de um /clear (ou /resume) na TUI a
// PTY escreve em OUTRA conversa. A fila tem de mirar a conversa viva: o índice
// ~/.claude/sessions real (num HOME temporário, com um processo de verdade como
// PTY), o app.db com as migrations reais e os transcripts no formato do claude.
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { HOME } = vi.hoisted(() => ({
  HOME: `${process.env.TMPDIR ?? '/tmp'}/cm-pq-live-cc-${process.pid}-${Date.now()}`,
}))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => HOME }
})
vi.mock('electron', () => ({
  app: { getPath: () => HOME, getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}))

import { openAppDb } from './db'
import { ptyManager } from './pty-manager'
import { liveConversationOf } from './conversation-holder'
import { PromptQueue } from './prompt-queue'
import { createPromptQueueStore, deliveryProof } from './prompt-queue-store'
import { fixture, scanOf } from './test-support/screen-scans'
import type { LiveStatus, ScreenScan } from '../../../shared/tui/attention-reason'

const PTY = 'pty-1'
const SPAWN_CC = '11111111-aaaa-4aaa-8aaa-000000000001'
const CLEARED_CC = '22222222-bbbb-4bbb-8bbb-000000000002'
const SESSIONS_DIR = join(HOME, '.claude', 'sessions')
const PROJECT_DIR = join(HOME, '.claude', 'projects', '-tmp-repo')

let idle: ScreenScan
let db: Database.Database
let proc: ChildProcess | null = null
let pid = 0

beforeAll(async () => {
  idle = await scanOf(fixture('claude-2.1.286-idle-prompt.ansi'))
})

beforeEach(() => {
  mkdirSync(PROJECT_DIR, { recursive: true })
  db = openAppDb(join(HOME, 'app.db'))
  db.prepare(
    `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, NULL, ?, 'running', 1)`,
  ).run(PTY, SPAWN_CC)
  // A PTY é um processo de verdade; o índice diz em que conversa ele está.
  proc = spawn('sleep', ['30'], { stdio: 'ignore' })
  pid = proc.pid as number
  vi.spyOn(ptyManager, 'getPid').mockImplementation((id) => (id === PTY ? pid : null))
})

afterEach(() => {
  proc?.kill()
  proc = null
  vi.restoreAllMocks()
  db.close()
  rmSync(HOME, { recursive: true, force: true })
})

// O <pid>.json que o claude reescreve ao trocar de conversa.
function ptyIsIn(cc: string): void {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  mkdirSync(SESSIONS_DIR, { recursive: true })
  writeFileSync(
    join(SESSIONS_DIR, `${pid}.json`),
    JSON.stringify({ pid, sessionId: cc, status: 'idle', updatedAt: Date.now(), procStart }),
  )
}

function claudeWrites(cc: string, text: string): void {
  const base = { isSidechain: false, userType: 'external', cwd: '/tmp/repo', sessionId: cc }
  const at = new Date().toISOString()
  appendFileSync(
    join(PROJECT_DIR, `${cc}.jsonl`),
    `${JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: text }, uuid: `u-${text}`, timestamp: at })}\n` +
      `${JSON.stringify({ ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, uuid: `a-${text}`, timestamp: at })}\n`,
  )
}

function makeQueue(state: { status: LiveStatus; onWrite?: (text: string) => void }) {
  const writes: string[] = []
  const queue = new PromptQueue({
    isRunning: (id) => id === PTY,
    status: () => state.status,
    screen: async () => idle,
    nativeStatus: () => true,
    handoffAsking: () => false,
    write: (_id, text) => {
      writes.push(text)
      state.onWrite?.(text)
    },
    emit: () => {},
    warn: () => {},
    store: createPromptQueueStore(() => db),
    deliveryProof,
    // O mesmo wiring de ipc/send-prompt.ts.
    liveCcOf: (id) => liveConversationOf(id),
  })
  return { queue, writes }
}

const rowCc = () =>
  (
    db.prepare('SELECT cc_session_id FROM prompt_queue_items').get() as
      { cc_session_id: string } | undefined
  )?.cc_session_id

describe('alvo durável = conversa viva da PTY', () => {
  it('liveConversationOf lê o índice real; sem entrada, null (vale a linha sessions)', () => {
    expect(liveConversationOf(PTY)).toBeNull()
    ptyIsIn(CLEARED_CC)
    expect(liveConversationOf(PTY)).toBe(CLEARED_CC)
  })

  it('enfileirado depois de um /clear: grava a conversa nova, não a do spawn', async () => {
    ptyIsIn(CLEARED_CC)
    const { queue } = makeQueue({ status: 'working' })
    await queue.send({ sessionId: PTY, text: 'segue', when: 'on-idle' })
    expect(rowCc()).toBe(CLEARED_CC)
    queue.dispose()
  })

  it('/clear entre o enqueue e a entrega + kill: o boot confere a conversa nova e não reenvia', async () => {
    ptyIsIn(SPAWN_CC)
    const state: { status: LiveStatus; onWrite?: (text: string) => void } = { status: 'working' }
    const first = makeQueue(state)
    await first.queue.send({ sessionId: PTY, text: 'roda o lint', when: 'on-idle' })
    expect(rowCc()).toBe(SPAWN_CC)

    // O usuário dá /clear; a mensagem entra na conversa nova.
    ptyIsIn(CLEARED_CC)
    state.onWrite = (text) => claudeWrites(CLEARED_CC, text)
    state.status = 'idle'
    first.queue.onTurnEnded(PTY)
    await new Promise((r) => setTimeout(r, 600))
    expect(first.writes).toEqual(['roda o lint'])
    expect(rowCc()).toBe(CLEARED_CC)
    // Kill -9 antes de a fila confirmar: a linha segue 'delivering'.
    first.queue.dispose()

    const boot = makeQueue({ status: 'idle' })
    boot.queue.restore()
    expect(boot.queue.snapshot().lastEvent).toMatchObject({ kind: 'delivered' })
    boot.queue.onSessionLive(PTY, CLEARED_CC)
    boot.queue.onTurnEnded(PTY)
    await new Promise((r) => setTimeout(r, 600))
    expect(boot.writes).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM prompt_queue_items').get()).toEqual({ n: 0 })
    boot.queue.dispose()
  })
})
