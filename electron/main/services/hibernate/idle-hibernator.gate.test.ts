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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeDb, getDb } from '../db'
import { isSessionPidAlive } from '../session-activity'
import * as handoffStore from '../handoff-store'
import { IdleHibernator, type IdleHibernatorDeps } from './idle-hibernator'
import { PANE_CHECK_TIMEOUT_MS, PaneConfirmer } from './pane-confirm'
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

// Campo 22 de /proc/<pid>/stat, como o claude grava no procStart.
function procStartOf(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
}

// Chaves e tipos copiados de um ~/.claude/sessions/<pid>.json real (claude 2.1.296,
// 10/10); só os valores identificadores foram trocados. procStart é o do processo
// do teste, para isSessionPidAlive (o leitor real) aceitar o pid.
function writeSessionFile(over: Record<string, unknown> = {}): void {
  mkdirSync(SESSIONS_DIR, { recursive: true })
  const pid = (over.pid as number | undefined) ?? process.pid
  const real = {
    pid,
    sessionId: CC,
    cwd: '/home/user/projetos/pessoal/claude-manager',
    startedAt: NOW - 5 * WINDOW,
    procStart: pid === process.pid ? procStartOf(pid) : '184015',
    version: '2.1.296',
    peerProtocol: 1,
    peerFeatures: ['notify_idle', 'reply_across_default_dirs', 'artifact_yield'],
    kind: 'interactive',
    entrypoint: 'cli',
    pidDomain: 'linux:708fa216fccc4e7b99ffa809881e561c:pid:[4026531836]',
    messagingSocketPath: `/tmp/claude-1000/messaging/${pid}.sock`,
    name: 'claude-manager',
    nameSource: 'user',
    nameSince: NOW - 5 * WINDOW,
    updatedAt: NOW - 2 * WINDOW,
    status: 'idle',
    statusUpdatedAt: NOW - 2 * WINDOW,
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

// Repo alvo do handoff (target_repo_id tem FK em repos).
function seedRepo(): void {
  const db = getDb()
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P1', 1, 1)`,
  ).run()
  db.prepare(
    `INSERT OR IGNORE INTO repos (id, project_id, label, path, position, created_at)
     VALUES ('r1', 'p1', 'Repo 1', ?, 0, 1)`,
  ).run(HOME)
}

// Aba confirmada, fora de foco e com o Composer vazio: pode hibernar.
function idlePane(paneId: string) {
  return { paneId, focused: false, composerHasText: false, composerFocused: false }
}

function gate(over: Partial<IdleHibernatorDeps> = {}): IdleHibernator {
  return new IdleHibernator({
    lazyRestore: () => true,
    afterMin: () => 30,
    candidates: () => claudeCandidates([PTY]),
    hasPane: (cc) => hasAwakePane(cc, () => false),
    confirmPane: async () => idlePane('pane-1'),
    registerDormant: () => {},
    lastIoAt: () => NOW - 2 * WINDOW,
    sessionFile: sessionFileFor,
    isPidAlive: (file) => isSessionPidAlive(file),
    aliveSessionId: () => PTY,
    activeHandoffCcSessionIds: () => [],
    isHandoffChild: handoffStore.isHandoffChildCc,
    queueHas: () => false,
    agentMessageSince,
    transcriptPath: () => '/fake/transcript.jsonl',
    scanTranscript: async () => 'clear',
    procTree: () => ({ ok: true }),
    send: async () => ({ ok: true, delivered: true }),
    cancel: () => {},
    replaceText: () => true,
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
  db.exec(
    'DELETE FROM agent_messages; DELETE FROM handoffs; DELETE FROM sessions; DELETE FROM workspace_state;',
  )
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

  it('c) pid reciclado (procStart de outro processo) → status-dead', async () => {
    writeSessionFile({ procStart: '1' })
    expect(await evaluate(gate())).toEqual({ ok: false, reason: 'status-dead' })
  })

  it('c) a PTY viva da conversa é outra (findAliveByCc) → status-dead', async () => {
    expect(await evaluate(gate({ aliveSessionId: () => 'pty-outra' }))).toEqual({
      ok: false,
      reason: 'status-dead',
    })
    expect(await evaluate(gate({ aliveSessionId: () => null }))).toEqual({
      ok: false,
      reason: 'status-dead',
    })
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

  it('d) filha de handoff já encerrada (done, pelo handoff-store) → handoff-child', async () => {
    seedRepo()
    const h = handoffStore.create({
      targetRepoId: 'r1',
      task: 't',
      composedPrompt: 'p',
      motherSessionId: null,
      mode: 'plan',
      status: 'approved',
    })
    handoffStore.markRunning(h.id, PTY)
    handoffStore.report(h.id, 'pronto')
    expect(handoffStore.get(h.id)?.status).toBe('done')
    // Fora do recorte "ativo": só o gate novo a segura.
    expect(handoffStore.activeHandoffCcSessionIds()).not.toContain(CC)
    expect(await evaluate(gate())).toEqual({ ok: false, reason: 'handoff-child' })
  })

  it('d) filha relinkada: a linha antiga da mesma conversa também conta', async () => {
    seedSession('pty-relink', CC)
    seedRepo()
    const h = handoffStore.create({
      targetRepoId: 'r1',
      task: 't',
      composedPrompt: 'p',
      motherSessionId: null,
      status: 'approved',
    })
    handoffStore.markRunning(h.id, 'pty-relink')
    handoffStore.fail(h.id, 'caiu')
    expect(await evaluate(gate())).toEqual({ ok: false, reason: 'handoff-child' })
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

  it('f) transcript ausente/ilegível → no-transcript; agendou → scheduled; background aberto → background-task', async () => {
    expect(await evaluate(gate({ transcriptPath: () => null }))).toEqual({
      ok: false,
      reason: 'no-transcript',
    })
    expect(await evaluate(gate({ scanTranscript: async () => null }))).toEqual({
      ok: false,
      reason: 'no-transcript',
    })
    expect(await evaluate(gate({ scanTranscript: async () => 'scheduled' }))).toEqual({
      ok: false,
      reason: 'scheduled',
    })
    expect(await evaluate(gate({ scanTranscript: async () => 'background-task' }))).toEqual({
      ok: false,
      reason: 'background-task',
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

describe('tick: as três condições', () => {
  const offCases: Array<[string, Partial<IdleHibernatorDeps>]> = [
    ['lazyRestore desligado', { lazyRestore: () => false }],
    ['afterMin 0', { afterMin: () => 0 }],
    ['afterMin negativo', { afterMin: () => -5 }],
  ]
  it.each(offCases)('%s → o tick não avalia nem age', async (_name, over) => {
    const candidates = vi.fn(() => claudeCandidates([PTY]))
    const send = vi.fn(async () => ({ ok: true, delivered: true }) as const)
    const h = gate({ ...over, candidates, send })
    await h.tick()
    expect(candidates).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(h.getStats()).toMatchObject({ afterMin: 0, hibernated: 0, lastTickAt: null })
    expect(Object.values(h.getStats().refused).every((n) => n === 0)).toBe(true)
  })

  it('reschedule não liga o timer com qualquer condição desligada', () => {
    vi.useFakeTimers()
    try {
      const candidates = vi.fn(() => [])
      let lazy = false
      const h = gate({ lazyRestore: () => lazy, candidates, tickMs: 1_000 })
      h.reschedule()
      vi.advanceTimersByTime(5_000)
      expect(candidates).not.toHaveBeenCalled()
      lazy = true
      h.reschedule()
      vi.advanceTimersByTime(1_000)
      expect(candidates).toHaveBeenCalledTimes(1)
      lazy = false
      h.reschedule()
      vi.advanceTimersByTime(5_000)
      expect(candidates).toHaveBeenCalledTimes(1)
      h.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('round-trip: o renderer responde a aba → /exit sai com o paneId confirmado', async () => {
    const asked: Array<{ sessionId: string; ccSessionId: string }> = []
    const confirmer = new PaneConfirmer({
      request: (r) => {
        asked.push({ sessionId: r.sessionId, ccSessionId: r.ccSessionId })
        queueMicrotask(() => confirmer.onResult({ requestId: r.requestId, ...idlePane('pane-7') }))
        return true
      },
    })
    const send = vi.fn(async () => ({ ok: true, delivered: true }) as const)
    const registered: string[] = []
    const h = gate({
      send,
      confirmPane: (id, cc) => confirmer.confirm(id, cc),
      registerDormant: (cc, paneId) => registered.push(`${cc}:${paneId}`),
      exitTimeoutMs: 60_000,
    })
    await h.tick()
    expect(asked).toEqual([{ sessionId: PTY, ccSessionId: CC }])
    expect(send).toHaveBeenCalledTimes(1)
    expect(h.onExit(PTY)).toEqual({ sessionId: PTY, ccSessionId: CC, paneId: 'pane-7' })
    expect(registered).toEqual([`${CC}:pane-7`])
    h.dispose()
  })

  it.each([
    ['o renderer diz que não há aba (open_panes atrasado)', 'null' as const],
    ['sem resposta em 3s', 'silent' as const],
    ['sem janela', 'no-window' as const],
  ])('round-trip sem confirmação (%s) → no-pane, sem /exit', async (_name, mode) => {
    vi.useFakeTimers()
    try {
      const confirmer = new PaneConfirmer({
        request: (r) => {
          if (mode === 'no-window') return false
          if (mode === 'null') {
            queueMicrotask(() =>
              confirmer.onResult({ requestId: r.requestId, ...idlePane('x'), paneId: null }),
            )
          }
          return true
        },
      })
      const send = vi.fn(async () => ({ ok: true, delivered: true }) as const)
      const h = gate({ send, confirmPane: (id, cc) => confirmer.confirm(id, cc) })
      const ticked = h.tick()
      await vi.advanceTimersByTimeAsync(PANE_CHECK_TIMEOUT_MS)
      await ticked
      expect(send).not.toHaveBeenCalled()
      expect(h.getStats().refused['no-pane']).toBe(1)
      expect(h.isHibernating(PTY)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['a aba é a focada', { focused: true }, 'pane-focused'],
    ['o Composer tem rascunho', { composerHasText: true }, 'composer-busy'],
    ['o Composer está com foco', { composerFocused: true }, 'composer-busy'],
  ] as const)('round-trip: %s → recusa %s, sem /exit', async (_name, over, reason) => {
    const confirmer = new PaneConfirmer({
      request: (r) => {
        queueMicrotask(() =>
          confirmer.onResult({ requestId: r.requestId, ...idlePane('pane-7'), ...over }),
        )
        return true
      },
    })
    const send = vi.fn(async () => ({ ok: true, delivered: true }) as const)
    const h = gate({ send, confirmPane: (id, cc) => confirmer.confirm(id, cc) })
    await h.tick()
    expect(send).not.toHaveBeenCalled()
    expect(h.getStats().refused[reason]).toBe(1)
    expect(h.isHibernating(PTY)).toBe(false)
  })

  it('tudo ligado → avalia o candidato real e manda o /exit', async () => {
    const send = vi.fn(async () => ({ ok: true, delivered: true }) as const)
    const h = gate({ send, exitTimeoutMs: 60_000 })
    await h.tick()
    expect(send).toHaveBeenCalledWith({ sessionId: PTY, text: '/exit', when: 'on-idle' })
    expect(h.isHibernating(PTY)).toBe(true)
    h.dispose()
  })
})
