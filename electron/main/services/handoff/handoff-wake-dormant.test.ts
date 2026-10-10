/** @vitest-environment node */
// Wake da mãe que está DORMINDO (lazy restore): DB real em tmp, handoff criado
// pelo handoff-store, registro de panes dormindo real (DormantPanes) com o
// "renderer" respondendo o resume, e a fila fake: a mãe antiga não tem PTY.
import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'handoff-wake-dormant-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import * as handoffStore from '../handoff-store'
import { DormantPanes, setDormantPanes } from '../dormant-panes'
import { __resetForTests, setHandoffWakeQueue, wakeHealth, wakeMotherFor } from './handoff-wake'
import type { ScreenScan } from '../../../../shared/tui/attention-reason'
import type { SendPromptInput, SendPromptResult } from '../../../../shared/types/send-prompt'

const OLD_MOTHER = 'mother-old'
const NEW_MOTHER = 'mother-new'
const SCAN = { menu: null, inputPrompt: true, inputDirty: false } as unknown as ScreenScan

function seed(finish: 'ask' | 'report' = 'report'): string {
  const db = getDb()
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',1,1)`,
  ).run()
  db.prepare(
    `INSERT OR IGNORE INTO repos (id, project_id, label, path, position, created_at) VALUES ('r1','p1','r1','/tmp/r1',0,1)`,
  ).run()
  const ins = db.prepare(
    `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at, title) VALUES (?, 'r1', ?, ?, ?, ?)`,
  )
  // A mãe de antes do restart: linha encerrada, mesma conversa (cc) da retomada.
  ins.run(OLD_MOTHER, 'cc-mother', 'exited', 1, 'mae')
  ins.run('child-1', 'cc-child', 'running', 2, 'filha')
  const h = handoffStore.create({
    targetRepoId: 'r1',
    task: 't',
    composedPrompt: 'p',
    motherSessionId: OLD_MOTHER,
    featureId: null,
  })
  handoffStore.approve(h.id, {})
  handoffStore.markRunning(h.id, 'child-1')
  if (finish === 'ask') handoffStore.ask(h.id, 'posso seguir?')
  else handoffStore.report(h.id, 'feito')
  return h.id
}

function dormant(answer: 'ok' | 'fail') {
  const running = new Set<string>()
  const panes: DormantPanes = new DormantPanes({
    requestWake: (req) => {
      if (answer === 'fail') return false
      queueMicrotask(() => {
        // O resume do renderer cria a linha nova (startSession) e a PTY sobe.
        getDb()
          .prepare(
            `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, 'r1', ?, 'running', ?)`,
          )
          .run(NEW_MOTHER, req.ccSessionId, Date.now())
        running.add(NEW_MOTHER)
        panes.onWakeResult({ requestId: req.requestId, sessionId: NEW_MOTHER })
      })
      return true
    },
    isRunning: (id) => running.has(id),
    screen: async (id) => (running.has(id) ? SCAN : null),
    warn: () => {},
    readyPollMs: 1,
  })
  panes.setDormant([{ ccSessionId: 'cc-mother', paneId: 'pane-m', title: 'mae', repoId: 'r1' }])
  setDormantPanes(panes)
  return panes
}

function fakeQueue() {
  const send = vi.fn(async (input: SendPromptInput): Promise<SendPromptResult> =>
    input.sessionId === NEW_MOTHER
      ? { ok: true, delivered: true }
      : { ok: false, error: 'not-running' },
  )
  setHandoffWakeQueue({ send, replaceText: () => true, cancel: () => true })
  return send
}

function rows() {
  return getDb()
    .prepare(
      'SELECT outcome, mother_session_id, detail FROM handoff_wake_deliveries ORDER BY created_at, rowid',
    )
    .all() as Array<{ outcome: string; mother_session_id: string; detail: string | null }>
}

beforeEach(() => {
  __resetForTests()
  setDormantPanes(null)
  const db = getDb()
  db.prepare('DELETE FROM handoff_wake_deliveries').run()
  db.prepare('DELETE FROM handoff_events').run()
  db.prepare('DELETE FROM handoffs').run()
  db.prepare('DELETE FROM sessions').run()
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('wake da mãe dormindo', () => {
  it('acorda a pane, transfere a liderança e entrega à sessão retomada', async () => {
    const id = seed('ask')
    dormant('ok')
    const send = fakeQueue()

    await wakeMotherFor(id, 'asked')

    expect(send.mock.calls.map(([i]) => i.sessionId)).toEqual([OLD_MOTHER, NEW_MOTHER])
    expect(handoffStore.get(id)?.motherSessionId).toBe(NEW_MOTHER)
    expect(rows()).toEqual([
      {
        outcome: 'woke_dormant',
        mother_session_id: OLD_MOTHER,
        detail: JSON.stringify({ from: OLD_MOTHER, to: NEW_MOTHER }),
      },
      { outcome: 'delivered', mother_session_id: NEW_MOTHER, detail: null },
    ])
    // A trilha do handoff guarda a troca de mãe (logEvent do transferMother).
    expect(handoffStore.listEvents(id).some((e) => e.event === 'mother_transferred')).toBe(true)
    expect(wakeHealth({}).undelivered).toBe(0)
  })

  it('handoff já terminal: entrega à retomada, mas a liderança (histórico) não muda', async () => {
    // transferMother só move o que a mãe ainda lidera (isLedByMother), como o bastão.
    const id = seed('report')
    dormant('ok')
    const send = fakeQueue()

    await wakeMotherFor(id, 'reported')

    expect(send.mock.calls.map(([i]) => i.sessionId)).toEqual([OLD_MOTHER, NEW_MOTHER])
    expect(handoffStore.get(id)?.motherSessionId).toBe(OLD_MOTHER)
    expect(rows().map((r) => r.outcome)).toEqual(['woke_dormant', 'delivered'])
  })

  it('wake falhou: linha wake_failed, a liderança fica e conta como não entregue', async () => {
    const id = seed()
    dormant('fail')
    const send = fakeQueue()

    await wakeMotherFor(id, 'reported')

    expect(send).toHaveBeenCalledTimes(1)
    expect(handoffStore.get(id)?.motherSessionId).toBe(OLD_MOTHER)
    expect(rows()).toEqual([
      { outcome: 'wake_failed', mother_session_id: OLD_MOTHER, detail: 'no-window' },
    ])
    expect(wakeHealth({}).undelivered).toBe(1)
  })

  it('mãe sem PTY e sem pane dormindo segue not_running', async () => {
    const id = seed()
    fakeQueue()

    await wakeMotherFor(id, 'reported')

    expect(rows()).toEqual([
      { outcome: 'not_running', mother_session_id: OLD_MOTHER, detail: 'not-running' },
    ])
  })
})
