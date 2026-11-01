/** @vitest-environment node */
// Restart com envelope de handoff na fila durável: a PromptQueue REAL com o store
// real sobre o app.db (migrations reais), handoffs e pedidos pelos produtores
// reais, telas reais da CLI 2.1.286. O "restart" descarta a fila e o estado em
// memória do acordador/da entrega de respostas e roda o boot de produção
// (restoreQueueWithLedger) sobre o mesmo banco.
import { rmSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'boot-ledger-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import * as handoffStore from '../handoff-store'
import * as requestStore from '../handoff-requests'
import { PromptQueue, SETTLE_MS } from '../prompt-queue'
import { createPromptQueueStore, type TranscriptProof } from '../prompt-queue-store'
import { fixture, scanOf } from '../test-support/screen-scans'
import {
  handoffAsking,
  type LiveStatus,
  type ScreenScan,
} from '../../../../shared/tui/attention-reason'
import {
  __resetForTests,
  onQueueSnapshot,
  setHandoffWakeQueue,
  wakeMotherFor,
} from './handoff-wake'
import {
  __resetAnswerDeliveryForTests,
  deliverAnswer,
  onAnswerQueueSnapshot,
} from './answer-delivery'
import { restoreQueueWithLedger } from './boot-ledger'

const MOTHER = 'mother-1'
const CHILD = 'child-1'
const CC = { [MOTHER]: 'cc-mother', [CHILD]: 'cc-child' } as Record<string, string>

const SCANS = {} as Record<'idle' | 'permission', ScreenScan>
beforeAll(async () => {
  SCANS.idle = await scanOf(fixture('claude-2.1.286-idle-prompt.ansi'))
  SCANS.permission = await scanOf(fixture('claude-2.1.286-permission-bash.ansi'))
})

const screens = new Map<string, { status: LiveStatus; scan: ScreenScan }>()
// A conversa gravou a mensagem e respondeu (padrão): a linha sai do banco.
const FOUND: TranscriptProof = { verdict: 'found', answered: true }
let proof: TranscriptProof = FOUND
let writes: Array<{ id: string; text: string }> = []
let queue: PromptQueue

function makeQueue(): PromptQueue {
  const q = new PromptQueue({
    isRunning: () => true,
    status: (id) => screens.get(id)?.status ?? 'idle',
    screen: async (id) => screens.get(id)?.scan ?? null,
    nativeStatus: () => true,
    handoffAsking: (id) => {
      const h = handoffStore.getByChildSession(id)
      return h ? handoffAsking(h) : false
    },
    write: (id, text) => writes.push({ id, text }),
    emit: (s) => {
      onQueueSnapshot(s)
      onAnswerQueueSnapshot(s)
    },
    warn: () => {},
    store: createPromptQueueStore(getDb),
    deliveryProof: () => proof,
  })
  setHandoffWakeQueue({
    send: (i) => q.send(i),
    replaceText: (id, t) => q.replaceText(id, t),
    cancel: (id) => q.cancel(id),
  })
  return q
}

// O app morre (kill -9/queda): some tudo que era memória; o app.db fica.
function restart(): void {
  queue.dispose()
  __resetForTests()
  __resetAnswerDeliveryForTests()
  writes = []
  queue = makeQueue()
  restoreQueueWithLedger(queue)
}

interface Row {
  wake_id: string
  mother_session_id: string
  reason: string
  outcome: string
  detail: string | null
}
const ledger = () =>
  getDb().prepare('SELECT * FROM handoff_wake_deliveries ORDER BY created_at, rowid').all() as Row[]
const queueRows = () =>
  getDb().prepare('SELECT id, state FROM prompt_queue_items').all() as Array<{
    id: string
    state: string
  }>

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
}

async function turnEnds(sessionId: string): Promise<void> {
  screens.set(sessionId, { status: 'idle', scan: SCANS.idle })
  queue.onTurnEnded(sessionId)
  await vi.advanceTimersByTimeAsync(SETTLE_MS + 10)
  await settle()
  queue.onTurnEnded(sessionId)
}

function liveHandoff(): string {
  const h = handoffStore.create({
    targetRepoId: 'r1',
    task: 't',
    composedPrompt: 'p',
    motherSessionId: MOTHER,
  })
  handoffStore.approve(h.id, {})
  handoffStore.markRunning(h.id, CHILD)
  return h.id
}

beforeEach(() => {
  __resetForTests()
  __resetAnswerDeliveryForTests()
  const db = getDb()
  for (const t of [
    'prompt_queue_items',
    'handoff_requests',
    'handoff_wake_deliveries',
    'handoff_events',
    'handoffs',
    'sessions',
  ])
    db.prepare(`DELETE FROM ${t}`).run()
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',1,1)`,
  ).run()
  db.prepare(
    `INSERT OR IGNORE INTO repos (id, project_id, label, path, position, created_at) VALUES ('r1','p1','R1','/tmp/r1',0,1)`,
  ).run()
  for (const id of [MOTHER, CHILD]) {
    db.prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, 'r1', ?, 'running', 1)`,
    ).run(id, CC[id])
  }
  proof = FOUND
  screens.clear()
  screens.set(MOTHER, { status: 'working', scan: SCANS.idle })
  screens.set(CHILD, { status: 'idle', scan: SCANS.idle })
  writes = []
  queue = makeQueue()
  vi.useFakeTimers()
})

afterEach(() => {
  queue.dispose()
  vi.useRealTimers()
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('restart com envelope de handoff na fila durável', () => {
  it('wake da mãe restaurado: o ledger não vira expired, e o desfecho real é registrado', async () => {
    const id = liveHandoff()
    handoffStore.ask(id, 'posso seguir?', CHILD)
    await wakeMotherFor(id, 'asked')
    await settle()
    expect(ledger()).toMatchObject([{ outcome: 'queued' }])
    const wakeId = ledger()[0].wake_id

    restart()
    expect(ledger()).toMatchObject([{ wake_id: wakeId, outcome: 'queued' }])

    queue.onSessionLive(MOTHER)
    await turnEnds(MOTHER)
    expect(writes.map((w) => w.id)).toEqual([MOTHER])
    expect(ledger()).toMatchObject([{ wake_id: wakeId, outcome: 'delivered' }])
    expect(queueRows()).toEqual([])
  })

  it('só o ledger do item que não voltou do app.db é varrido', async () => {
    const id = liveHandoff()
    handoffStore.ask(id, 'posso seguir?', CHILD)
    await wakeMotherFor(id, 'asked')
    await settle()
    // Envelope que existia só em memória (antes da fila durável): o item sumiu.
    getDb()
      .prepare(
        `INSERT INTO handoff_wake_deliveries (id, wake_id, handoff_id, mother_session_id, reason, outcome, created_at)
         VALUES ('orfa', 'wake-sem-item', ?, ?, 'asked', 'queued', 1)`,
      )
      .run(id, MOTHER)

    restart()
    const byWake = Object.fromEntries(ledger().map((r) => [r.wake_id, r]))
    expect(byWake['wake-sem-item']).toMatchObject({ outcome: 'expired', detail: 'app-restart' })
    expect(Object.values(byWake).filter((r) => r.outcome === 'queued')).toHaveLength(1)
  })

  it('evento novo depois do restart coalesce no envelope restaurado', async () => {
    const id = liveHandoff()
    handoffStore.ask(id, 'posso seguir?', CHILD)
    await wakeMotherFor(id, 'asked')
    await settle()

    restart()
    handoffStore.report(id, 'terminei')
    await wakeMotherFor(id, 'reported')
    await settle()

    expect(queue.snapshot().items).toHaveLength(1)
    expect(queueRows()).toHaveLength(1)
    const wakeIds = new Set(ledger().map((r) => r.wake_id))
    expect(wakeIds.size).toBe(1)
    expect(queue.snapshot().items[0].text).toContain('terminei')
  })

  it('resposta à filha segurada por menu: sobrevive ao restart e é registrada como entregue', async () => {
    const id = liveHandoff()
    const a = handoffStore.ask(id, 'qual lib?', CHILD).request!
    screens.set(CHILD, { status: 'waiting', scan: SCANS.permission })
    await deliverAnswer(requestStore.answerRequest(a.id, { text: 'zod', by: 'human' }))
    await settle()
    expect(ledger()).toMatchObject([{ reason: 'answered', outcome: 'held' }])

    restart()
    // Segue transitória (a tela ainda não foi relida desde o boot), nunca expired.
    expect(ledger()).toMatchObject([{ reason: 'answered', outcome: 'queued' }])

    queue.onSessionLive(CHILD)
    await turnEnds(CHILD)
    expect(writes.map((w) => w.id)).toEqual([CHILD])
    expect(ledger()).toMatchObject([{ reason: 'answered', outcome: 'delivered' }])
  })

  it.each([
    { name: 'wake da mãe', reason: 'asked' },
    { name: 'resposta à filha', reason: 'answered' },
  ])(
    '$name em delivering sem prova no boot: fica visível (held/maybe-undelivered) e o Reenviar fecha como entregue',
    async ({ reason }) => {
      const id = liveHandoff()
      const a = handoffStore.ask(id, 'posso seguir?', CHILD).request!
      const target = reason === 'asked' ? MOTHER : CHILD
      screens.set(target, { status: 'working', scan: SCANS.idle })
      if (reason === 'asked') await wakeMotherFor(id, 'asked')
      else await deliverAnswer(requestStore.answerRequest(a.id, { text: 'sim', by: 'human' }))
      await settle()
      expect(ledger()).toMatchObject([{ reason, outcome: 'queued' }])
      const wakeId = ledger()[0].wake_id

      // Queda no meio da entrega: o 'delivering' (FULL) chegou ao app.db e o
      // desfecho do ledger não. O boot não acha a mensagem no transcript.
      createPromptQueueStore(getDb).markDelivering(wakeId, Date.now(), CC[target])
      proof = { verdict: 'unknown', answered: false }
      restart()

      expect(queue.snapshot().items).toEqual([
        expect.objectContaining({ id: wakeId, recovery: 'maybe-undelivered' }),
      ])
      const row = () =>
        getDb()
          .prepare(
            'SELECT outcome, detail, finished_at FROM handoff_wake_deliveries WHERE wake_id = ?',
          )
          .get(wakeId)
      expect(row()).toEqual({ outcome: 'held', detail: 'maybe-undelivered', finished_at: null })

      // O usuário clica Reenviar no toast: entregue uma vez, e o ledger fecha.
      proof = FOUND
      queue.onSessionLive(target)
      expect(queue.resend(wakeId)).toBe(true)
      await turnEnds(target)
      expect(writes.map((w) => w.id)).toEqual([target])
      expect(row()).toMatchObject({ outcome: 'delivered', detail: null })
    },
  )
})
