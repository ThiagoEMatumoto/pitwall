/** @vitest-environment node */
// Regressão: <pitwall-answer> de pedido escalado e respondido pelo humano não chega à
// filha idle quando a sessão é NOMEADA (claude 2.1.295 desenha o nome na régua).
import { EventEmitter } from 'node:events'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'named-answer-repro-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import * as handoffStore from '../handoff-store'
import * as requestStore from '../handoff-requests'
import { PromptQueue, POLL_MS } from '../prompt-queue'
import { TuiMenuWatch } from '../tui-menu-watch'
import { FIXTURES } from '../test-support/screen-scans'
import { handoffAsking, type ScreenScan } from '../../../../shared/tui/attention-reason'
import { __resetForTests, onQueueSnapshot, setHandoffWakeQueue } from './handoff-wake'
import { __resetAnswerDeliveryForTests, deliverAnswer, onAnswerQueueSnapshot } from './answer-delivery'

const MOTHER = 'mother-1'
const CHILD = 'child-1'

class FakePty extends EventEmitter { write(): void {} }
async function scanAt(name: string, cols: number, rows: number): Promise<ScreenScan> {
  const pty = new FakePty()
  const watch = new TuiMenuWatch()
  watch.attach(pty)
  pty.emit('spawn', { sessionId: 'probe', cols, rows })
  pty.emit('data', { sessionId: 'probe', data: readFileSync(join(FIXTURES, name), 'utf8') })
  const scan = await watch.rescan('probe')
  pty.emit('exit', { sessionId: 'probe', exitCode: 0 })
  return scan!
}

let named: ScreenScan
let unnamed: ScreenScan
beforeAll(async () => {
  named = await scanAt('claude-2.1.295-named-idle-45x50.ansi', 45, 50)
  unnamed = await scanAt('claude-2.1.295-unnamed-idle-45x50.ansi', 45, 50)
})

let childScan: ScreenScan
let writes: Array<{ id: string; text: string }> = []
let queue: PromptQueue

beforeEach(() => {
  __resetForTests()
  __resetAnswerDeliveryForTests()
  const db = getDb()
  for (const t of ['handoff_requests', 'handoff_wake_deliveries', 'handoff_events', 'handoffs'])
    db.prepare(`DELETE FROM ${t}`).run()
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',1,1)`).run()
  db.prepare(`INSERT OR IGNORE INTO repos (id, project_id, label, path, position, created_at) VALUES ('r1','p1','R1','/tmp/r1',0,1)`).run()
  writes = []
  queue = new PromptQueue({
    isRunning: () => true,
    status: () => 'idle',
    screen: async (id) => (id === CHILD ? childScan : unnamed),
    nativeStatus: () => true,
    handoffAsking: (id) => {
      const h = handoffStore.getByChildSession(id)
      return h ? handoffAsking(h) : false
    },
    write: (id, text) => writes.push({ id, text }),
    emit: (s) => { onQueueSnapshot(s); onAnswerQueueSnapshot(s) },
    warn: () => {},
  })
  setHandoffWakeQueue({
    send: (i) => queue.send(i),
    replaceText: (id, t) => queue.replaceText(id, t),
    cancel: (id) => queue.cancel(id),
  })
  vi.useFakeTimers()
})
afterEach(() => { queue.dispose(); vi.useRealTimers() })
afterAll(() => { closeDb(); rmSync(app.getPath('userData'), { recursive: true, force: true }) })

async function escalateAndAnswerAsHuman() {
  const h = handoffStore.create({ targetRepoId: 'r1', task: 't', composedPrompt: 'p', motherSessionId: MOTHER })
  handoffStore.approve(h.id, {})
  handoffStore.markRunning(h.id, CHILD)
  const req = handoffStore.ask(h.id, 'posso mergear?', CHILD).request!
  requestStore.escalateRequest(req.id, MOTHER)
  const answered = requestStore.answerRequest(req.id, { text: 'A', by: 'human' })
  await deliverAnswer(answered)
  // 10 ticks do poll de 3s: a fila não depende de borda working→idle.
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(POLL_MS)
  return getDb()
    .prepare(`SELECT mother_session_id AS target, outcome, detail FROM handoff_wake_deliveries WHERE reason='answered'`)
    .all() as Array<{ target: string; outcome: string; detail: string | null }>
}

describe('resposta humana a pedido escalado, filha já idle', () => {
  it('controle: filha sem nome (2.1.295) recebe o <pitwall-answer>', async () => {
    childScan = unnamed
    expect(unnamed.inputPrompt).toBe(true)
    const rows = await escalateAndAnswerAsHuman()
    expect(rows.find((r) => r.target === CHILD)?.outcome).toBe('delivered')
    expect(writes.some((w) => w.id === CHILD && w.text.startsWith('<pitwall-answer'))).toBe(true)
  })

  it('filha NOMEADA (2.1.295, régua "──── nome ─") recebe o <pitwall-answer>', async () => {
    childScan = named
    expect(named.inputPrompt).toBe(true)
    expect(named.inputDirty).toBe(false)
    const rows = await escalateAndAnswerAsHuman()
    expect(rows.find((r) => r.target === CHILD)?.outcome).toBe('delivered')
    expect(writes.some((w) => w.id === CHILD && w.text.startsWith('<pitwall-answer'))).toBe(true)
  })
})
