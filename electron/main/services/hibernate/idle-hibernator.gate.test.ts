/** @vitest-environment node */
// Gate H2 contra os produtores reais: ~/.claude/sessions/<pid>.json no shape que o
// claude grava (lido pelo buildSessionsFileIndex de verdade), DB better-sqlite3 com
// as migrations do app (open_panes como o workspace:save-panes grava, agent_messages
// como o agent-bus grava).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const HOME = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return mkdtempSync(join(tmpdir(), 'hibernate-gate-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => HOME, getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {},
}))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => HOME }
})

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeDb, getDb } from '../db'
import { IdleHibernator, type IdleHibernatorDeps } from './idle-hibernator'
import {
  agentMessageSince,
  claudeCandidates,
  hasAwakePane,
  sessionFileFor,
} from './hibernate-sources'

const SESSIONS_DIR = join(HOME, '.claude', 'sessions')
const MIN = 60_000
const NOW = 10_000_000_000
const WINDOW = 30 * MIN
const CC = '74f13261-5b8e-4f43-9d0e-2c5a2b1f7c11'
const PTY = 'pty-1'

// Chaves exatamente as do arquivo real (plano, fatos verificados 10/10): pid,
// sessionId, cwd, status, statusUpdatedAt, updatedAt, name, messagingSocketPath.
function writeSessionFile(over: Record<string, unknown> = {}): void {
  mkdirSync(SESSIONS_DIR, { recursive: true })
  const pid = (over.pid as number | undefined) ?? process.pid
  const real = {
    pid,
    sessionId: CC,
    cwd: '/home/user/projetos/pessoal/claude-manager',
    status: 'idle',
    statusUpdatedAt: NOW - 2 * WINDOW,
    updatedAt: NOW - 2 * WINDOW,
    name: 'claude-manager',
    messagingSocketPath: `/tmp/claude-1000/messaging/${pid}.sock`,
    ...over,
  }
  writeFileSync(join(SESSIONS_DIR, `${pid}.json`), JSON.stringify(real))
}

function seedSession(id: string, cc: string, provider = 'claude'): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, title, status, started_at, provider)
       VALUES (?, NULL, ?, NULL, 'running', ?, ?)`,
    )
    .run(id, cc, NOW, provider)
}

function savePanes(ccs: string[]): void {
  const panes = ccs.map((cc) => ({
    ccSessionId: cc,
    paneId: `pane-${cc}`,
    repo: null,
    projectName: null,
    projectIcon: null,
    projectColor: null,
  }))
  getDb()
    .prepare(
      `INSERT INTO workspace_state (id, last_opened_at, open_panes) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET open_panes = excluded.open_panes`,
    )
    .run(NOW, JSON.stringify(panes))
}

function ask(from: string, to: string, createdAt: number, status = 'answered'): void {
  getDb()
    .prepare(
      `INSERT INTO agent_messages
         (id, from_session_id, to_session_id, to_repo_id, feature_id, depth, text, status, created_at, expires_at)
       VALUES (?, ?, ?, NULL, NULL, 0, 'q', ?, ?, ?)`,
    )
    .run(`ask-${Math.random()}`, from, to, status, createdAt, createdAt + 60 * MIN)
}

function gate(over: Partial<IdleHibernatorDeps> = {}): IdleHibernator {
  return new IdleHibernator({
    afterMin: () => 30,
    candidates: () => claudeCandidates([PTY]),
    hasPane: (cc) => hasAwakePane(cc, () => false),
    lastIoAt: () => NOW - 2 * WINDOW,
    sessionFile: sessionFileFor,
    isPidAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    activeHandoffCcSessionIds: () => [],
    queueHas: () => false,
    agentMessageSince,
    transcriptPath: () => '/fake/transcript.jsonl',
    usedScheduling: async () => false,
    procTree: () => ({ ok: true }),
    send: async () => ({ ok: true, delivered: true }),
    cancel: () => {},
    warn: () => {},
    now: () => NOW,
    ...over,
  })
}

const evaluate = (h: IdleHibernator, handoff: string[] = []) =>
  h.evaluate({ sessionId: PTY, ccSessionId: CC }, WINDOW, new Set(handoff))

beforeEach(() => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true })
  const db = getDb()
  db.exec('DELETE FROM agent_messages; DELETE FROM sessions; DELETE FROM workspace_state;')
  seedSession(PTY, CC)
  savePanes([CC])
  writeSessionFile()
})

afterAll(() => {
  closeDb()
  rmSync(HOME, { recursive: true, force: true })
})

describe('gate da hibernação (fontes reais)', () => {
  it('sessão ociosa no shape real passa em todos os gates', async () => {
    expect(await evaluate(gate())).toEqual({ ok: true, pid: process.pid })
  })

  it('candidatos: só claude com cc e PTY viva', () => {
    seedSession('pty-codex', 'codex-cc', 'codex')
    expect(claudeCandidates([PTY, 'pty-codex', 'pty-morta'])).toEqual([
      { sessionId: PTY, ccSessionId: CC },
    ])
  })

  it('a) sem aba no layout salvo, ou aba dormindo → no-pane', async () => {
    savePanes(['outra-conversa'])
    expect(await evaluate(gate())).toEqual({ ok: false, reason: 'no-pane' })
    savePanes([CC])
    const dormant = gate({ hasPane: (cc) => hasAwakePane(cc, () => true) })
    expect(await evaluate(dormant)).toEqual({ ok: false, reason: 'no-pane' })
  })

  it('b) I/O recente no PTY → io-recent', async () => {
    const h = gate({ lastIoAt: () => NOW - WINDOW + 1 })
    expect(await evaluate(h)).toEqual({ ok: false, reason: 'io-recent' })
  })

  it('c) sem arquivo / JSON quebrado → status-missing', async () => {
    rmSync(SESSIONS_DIR, { recursive: true, force: true })
    expect(await evaluate(gate())).toEqual({ ok: false, reason: 'status-missing' })
    mkdirSync(SESSIONS_DIR, { recursive: true })
    writeFileSync(join(SESSIONS_DIR, `${process.pid}.json`), '{"pid":')
    expect(await evaluate(gate())).toEqual({ ok: false, reason: 'status-missing' })
  })

  it('c) pid morto → status-dead', async () => {
    rmSync(SESSIONS_DIR, { recursive: true, force: true })
    writeSessionFile({ pid: 2 ** 22 + 7 })
    expect(await evaluate(gate())).toEqual({ ok: false, reason: 'status-dead' })
  })

  it.each(['busy', 'waiting', 'shell', null])('c) status %s → status-not-idle', async (status) => {
    writeSessionFile({ status })
    expect(await evaluate(gate())).toEqual({ ok: false, reason: 'status-not-idle' })
  })

  it('c) status sem a chave → status-not-idle', async () => {
    rmSync(SESSIONS_DIR, { recursive: true, force: true })
    writeSessionFile({ status: undefined })
    expect(await evaluate(gate())).toEqual({ ok: false, reason: 'status-not-idle' })
  })

  it('c) idle há menos de N min, ou sem statusUpdatedAt → status-recent', async () => {
    writeSessionFile({ statusUpdatedAt: NOW - WINDOW + 1 })
    expect(await evaluate(gate())).toEqual({ ok: false, reason: 'status-recent' })
    writeSessionFile({ statusUpdatedAt: undefined })
    expect(await evaluate(gate())).toEqual({ ok: false, reason: 'status-recent' })
  })

  it('d) handoff ativo → handoff; item na fila → queue', async () => {
    expect(await evaluate(gate(), [CC])).toEqual({ ok: false, reason: 'handoff' })
    const queued = gate({ queueHas: (id) => id === PTY })
    expect(await evaluate(queued)).toEqual({ ok: false, reason: 'queue' })
  })

  it('e) agent_ask recente (de/para qualquer sessions.id da conversa) → agent-msg', async () => {
    seedSession('pty-antiga', CC)
    seedSession('pty-outra', 'outra')
    ask('pty-outra', 'pty-antiga', NOW - 5 * MIN)
    expect(await evaluate(gate())).toEqual({ ok: false, reason: 'agent-msg' })
  })

  it('e) agent_ask antigo e respondido não recusa; pendente antigo recusa', async () => {
    seedSession('pty-outra', 'outra')
    ask(PTY, 'pty-outra', NOW - 3 * WINDOW)
    expect(await evaluate(gate())).toEqual({ ok: true, pid: process.pid })
    ask('pty-outra', PTY, NOW - 3 * WINDOW, 'pending')
    expect(await evaluate(gate())).toEqual({ ok: false, reason: 'agent-msg' })
  })

  it('f) transcript ausente/ilegível → no-transcript; agendou → scheduled', async () => {
    expect(await evaluate(gate({ transcriptPath: () => null }))).toEqual({
      ok: false,
      reason: 'no-transcript',
    })
    expect(await evaluate(gate({ usedScheduling: async () => null }))).toEqual({
      ok: false,
      reason: 'no-transcript',
    })
    expect(await evaluate(gate({ usedScheduling: async () => true }))).toEqual({
      ok: false,
      reason: 'scheduled',
    })
  })

  it('g) árvore com bloqueador → proc-tree (com o pid do arquivo do claude)', async () => {
    const seen: number[] = []
    const h = gate({
      procTree: (pid) => {
        seen.push(pid)
        return { ok: false, blocker: 'shell:bash' }
      },
    })
    expect(await evaluate(h)).toEqual({ ok: false, reason: 'proc-tree' })
    expect(seen).toEqual([process.pid])
  })
})
