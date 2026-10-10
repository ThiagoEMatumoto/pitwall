// Ask para uma sessão DORMINDO (lazy restore): sem PTY ela não está em peers();
// o bus acha a pane no registro (DormantPanes real), acorda e entrega pela
// PromptQueue real com a tela REAL do claude 2.1.286 (espelho headless).
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './migrations'
import { TuiMenuWatch } from './tui-menu-watch'
import { PromptQueue } from './prompt-queue'
import { AgentBus, AgentBusError, ASK_RATE_PER_MINUTE } from './agent-bus'
import { DormantPanes } from './dormant-panes'
import type { LiveStatus, ScreenScan } from '../../../shared/tui/attention-reason'
import type { AgentBusSnapshot, AgentPeer } from '../../../shared/types/agent-bus'

const FIXTURES = join(__dirname, '..', '..', '..', 'shared', 'tui', '__fixtures__')
const IDLE_PROMPT = readFileSync(join(FIXTURES, 'claude-2.1.286-idle-prompt.ansi'), 'utf8')

class FakePty extends EventEmitter {
  write(): void {}
}

let IDLE_SCAN: ScreenScan
beforeAll(async () => {
  const pty = new FakePty()
  const watch = new TuiMenuWatch()
  watch.attach(pty)
  pty.emit('spawn', { sessionId: 'probe', cols: 80, rows: 24 })
  pty.emit('data', { sessionId: 'probe', data: IDLE_PROMPT })
  const scan = await watch.rescan('probe')
  if (!scan) throw new Error('sem scan')
  IDLE_SCAN = scan
})

const FRONT = 'aaaaaaaa-0000-4000-8000-000000000001'
const API_NEW = 'aaaaaaaa-0000-4000-8000-0000000000aa'

interface Harness {
  bus: AgentBus
  db: Database.Database
  written: Array<{ sessionId: string; text: string }>
  wakeRequests: string[]
  snapshots: AgentBusSnapshot[]
  warns: Array<Record<string, unknown>>
  panes: DormantPanes
}

function harness(opts: { wakeWorks: boolean }): Harness {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  for (const m of migrations) m.up(db)
  db.exec(`
    INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p-loja', 'Loja', 1, 1);
    INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES
      ('r-front', 'p-loja', 'front', '/tmp/front', 0, 1),
      ('r-api', 'p-loja', 'api', '/tmp/api', 1, 1);
    INSERT INTO sessions (id, repo_id, cc_session_id, title, status, started_at) VALUES
      ('${FRONT}', 'r-front', 'cc-front', 'web-front', 'running', 1);
  `)
  const peers: AgentPeer[] = [
    {
      sessionId: FRONT,
      alias: 'web-front',
      address: null,
      projectId: 'p-loja',
      projectName: 'Loja',
      repoId: 'r-front',
      repoLabel: 'front',
      provider: 'claude',
      status: 'idle',
      purpose: null,
      lastActivityAt: 1,
      startedAt: 1,
    },
  ]
  const status = new Map<string, LiveStatus>([[FRONT, 'idle']])
  const written: Harness['written'] = []
  const wakeRequests: string[] = []
  const warns: Harness['warns'] = []
  const running = () => new Set(peers.map((p) => p.sessionId))
  const queue = new PromptQueue({
    isRunning: (id) => running().has(id),
    status: (id) => status.get(id) ?? null,
    screen: async (id) => (running().has(id) ? IDLE_SCAN : null),
    nativeStatus: () => true,
    handoffAsking: () => false,
    write: (sessionId, text) => written.push({ sessionId, text }),
    emit: () => {},
    warn: () => {},
  })
  const panes: DormantPanes = new DormantPanes({
    // O renderer retoma a pane: sessions:resume grava a linha e a PTY sobe.
    requestWake: (req) => {
      wakeRequests.push(req.ccSessionId)
      if (!opts.wakeWorks) return false
      queueMicrotask(() => {
        db.prepare(
          `INSERT INTO sessions (id, repo_id, cc_session_id, title, status, started_at) VALUES (?, 'r-api', ?, 'api-contrato', 'running', 2)`,
        ).run(API_NEW, req.ccSessionId)
        peers.push({ ...peers[0], sessionId: API_NEW, alias: 'api-contrato', repoId: 'r-api' })
        status.set(API_NEW, 'idle')
        panes.onWakeResult({ requestId: req.requestId, sessionId: API_NEW })
      })
      return true
    },
    isRunning: (id) => running().has(id),
    screen: async (id) => (running().has(id) ? IDLE_SCAN : null),
    status: (id) => status.get(id) ?? null,
    warn: () => {},
    readyPollMs: 1,
  })
  panes.setDormant([
    { ccSessionId: 'cc-api', paneId: 'pane-api', title: 'api-contrato', repoId: 'r-api' },
  ])
  const snapshots: AgentBusSnapshot[] = []
  const bus = new AgentBus({
    db,
    peers: () => peers,
    send: (input) => queue.send(input),
    cancel: (id) => queue.cancel(id),
    emit: (snap) => snapshots.push(snap),
    warn: (e) => warns.push(e),
    dormant: {
      byAlias: (name) => panes.findDormantByAlias(name),
      byRepo: (repoId) => panes.findDormantByRepo(repoId),
      wake: (cc) => panes.wakeDormant(cc, 'agent-bus'),
    },
  })
  return { bus, db, written, wakeRequests, snapshots, warns, panes }
}

let h: Harness

describe('AgentBus → sessão dormindo', () => {
  beforeEach(() => {
    h = harness({ wakeWorks: true })
  })

  it('por apelido: acorda a pane e entrega no sessions.id novo', async () => {
    const out = await h.bus.ask({
      fromSessionId: FRONT,
      to: 'API-Contrato',
      text: 'qual o schema?',
    })

    expect(h.wakeRequests).toEqual(['cc-api'])
    expect(out.mode).toBe('delivered')
    expect(out.routedTo?.sessionId).toBe(API_NEW)
    expect(h.written).toHaveLength(1)
    expect(h.written[0].sessionId).toBe(API_NEW)
    expect(h.written[0].text).toContain('qual o schema?')
    const row = h.db.prepare('SELECT to_session_id FROM agent_messages').get() as {
      to_session_id: string
    }
    expect(row.to_session_id).toBe(API_NEW)
    expect(h.snapshots.at(-1)?.counters.wokeDormant).toBe(1)
    expect(h.warns).toContainEqual(
      expect.objectContaining({ event: 'agent_bus_woke_dormant', sessionId: API_NEW }),
    )
  })

  it('por repo sem sessão viva: acorda a pane dormindo do repo em vez de sugerir handoff', async () => {
    const out = await h.bus.ask({ fromSessionId: FRONT, repo: 'api', text: 'oi' })

    expect(out.mode).toBe('delivered')
    expect(out.routedTo?.sessionId).toBe(API_NEW)
    expect(h.snapshots.at(-1)?.counters.needsHandoff).toBe(0)
  })

  it('por repo com várias dormindo: acorda a de sessions.started_at mais recente', async () => {
    h.db.exec(`
      INSERT INTO sessions (id, repo_id, cc_session_id, title, status, started_at) VALUES
        ('api-velha', 'r-api', 'cc-api', 'api-contrato', 'exited', 5),
        ('api2-recente', 'r-api', 'cc-api2', 'api-2', 'exited', 50);
    `)
    h.panes.setDormant([
      { ccSessionId: 'cc-api', paneId: 'pane-api', title: 'api-contrato', repoId: 'r-api' },
      { ccSessionId: 'cc-api2', paneId: 'pane-api2', title: 'api-2', repoId: 'r-api' },
    ])

    await h.bus.ask({ fromSessionId: FRONT, repo: 'api', text: 'oi' })

    expect(h.wakeRequests).toEqual(['cc-api2'])
  })

  it('rate antes do wake: com o limite estourado para a conversa, não acorda nada', async () => {
    h.db.exec(
      `INSERT INTO sessions (id, repo_id, cc_session_id, title, status, started_at) VALUES ('api-velha', 'r-api', 'cc-api', 'api-contrato', 'exited', 1)`,
    )
    const insert = h.db.prepare(
      `INSERT INTO agent_messages (id, from_session_id, to_session_id, depth, text, status, created_at, expires_at)
       VALUES (?, ?, 'api-velha', 1, 'x', 'answered', ?, ?)`,
    )
    const now = Date.now()
    for (let i = 0; i < ASK_RATE_PER_MINUTE; i++) insert.run(`m-${i}`, FRONT, now, now + 60_000)

    await expect(
      h.bus.ask({ fromSessionId: FRONT, to: 'api-contrato', text: 'oi' }),
    ).rejects.toThrow('Limite de perguntas')

    expect(h.wakeRequests).toEqual([])
    expect(h.snapshots.at(-1)?.counters.rejectedRate).toBe(1)
  })

  it('apelido que não existe nem dormindo segue o erro de sempre', async () => {
    await expect(h.bus.ask({ fromSessionId: FRONT, to: 'ninguem', text: 'oi' })).rejects.toThrow(
      'Nenhuma sessão viva com o apelido',
    )
    expect(h.wakeRequests).toEqual([])
  })
})

describe('AgentBus → wake falhou', () => {
  it('não grava ask, conta wakeFailed e devolve erro explicando', async () => {
    h = harness({ wakeWorks: false })

    await expect(
      h.bus.ask({ fromSessionId: FRONT, to: 'api-contrato', text: 'oi' }),
    ).rejects.toThrow(AgentBusError)

    expect(h.written).toEqual([])
    expect(
      (h.db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }).n,
    ).toBe(0)
    expect(h.snapshots.at(-1)?.counters.wakeFailed).toBe(1)
    expect(h.warns).toContainEqual(
      expect.objectContaining({ event: 'agent_bus_wake_failed', error: 'no-window' }),
    )
  })
})
