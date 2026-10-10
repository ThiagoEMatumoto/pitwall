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
import { setPref } from '../prefs-store'
import { LAZY_RESTORE_PREF, lazyRestoreEnabled } from '../restore-plan'
import {
  WAKE_CAP_PER_HANDOFF_PER_HOUR,
  __resetForTests,
  insertRow,
  redeliverFailedWakes,
  setHandoffWakeQueue,
  wakeHealth,
  wakeMotherFor,
} from './handoff-wake'
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

const wakeRequests: string[] = []

// onResume: o hook de sessão retomada do main (sessions:resume → reenvio dos
// wake_failed) roda dentro do resume, antes de o wake devolver o id novo.
function dormant(answer: 'ok' | 'fail', onResume?: () => void) {
  const running = new Set<string>()
  const panes: DormantPanes = new DormantPanes({
    requestWake: (req) => {
      wakeRequests.push(req.ccSessionId)
      if (answer === 'fail') return false
      queueMicrotask(() => {
        // O resume do renderer cria a linha nova (startSession) e a PTY sobe.
        getDb()
          .prepare(
            `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, 'r1', ?, 'running', ?)`,
          )
          .run(NEW_MOTHER, req.ccSessionId, Date.now())
        running.add(NEW_MOTHER)
        onResume?.()
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
  // Mesmo gate do main: a pref real, lida do app_prefs.
  setDormantPanes(panes, lazyRestoreEnabled)
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
  setPref(LAZY_RESTORE_PREF, true)
  wakeRequests.length = 0
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

describe('reenvio dos wake_failed quando a mãe volta', () => {
  // O resume da mãe (wake ou clique) cria a linha nova da MESMA conversa.
  function motherResumed() {
    getDb()
      .prepare(
        `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, 'r1', 'cc-mother', 'running', ?)`,
      )
      .run(NEW_MOTHER, Date.now())
  }

  it('reenfileira on-idle para a sessão retomada, uma vez só', async () => {
    const id = seed('report')
    dormant('fail')
    const send = fakeQueue()
    await wakeMotherFor(id, 'reported')
    expect(rows().map((r) => r.outcome)).toEqual(['wake_failed'])

    motherResumed()
    expect(await redeliverFailedWakes(NEW_MOTHER)).toBe(1)

    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ sessionId: NEW_MOTHER, when: 'on-idle' })
    expect(rows().map((r) => [r.outcome, r.mother_session_id])).toEqual([
      ['wake_failed', OLD_MOTHER],
      ['delivered', NEW_MOTHER],
    ])

    // Segundo resume da mesma conversa: já entregue, nada sai de novo.
    const calls = send.mock.calls.length
    expect(await redeliverFailedWakes(NEW_MOTHER)).toBe(0)
    expect(send.mock.calls.length).toBe(calls)
  })

  it('reenvio e wake da mesma conversa em série: o update sai uma vez só', async () => {
    const id = seed('report')
    dormant('fail')
    const send = fakeQueue()
    await wakeMotherFor(id, 'reported')
    expect(rows().map((r) => r.outcome)).toEqual(['wake_failed'])

    // Novo evento com a mãe ainda dormindo; desta vez o wake funciona e o resume
    // dela dispara o reenvio enquanto o wake ainda não terminou.
    let redelivery: Promise<number> | null = null
    dormant('ok', () => {
      redelivery = redeliverFailedWakes(NEW_MOTHER)
    })
    await wakeMotherFor(id, 'reported')
    expect(await redelivery).toBe(0)

    expect(send.mock.calls.filter(([i]) => i.sessionId === NEW_MOTHER)).toHaveLength(1)
    expect(rows().map((r) => [r.outcome, r.mother_session_id])).toEqual([
      ['wake_failed', OLD_MOTHER],
      ['woke_dormant', OLD_MOTHER],
      ['delivered', NEW_MOTHER],
    ])
  })

  it('wake_failed que o handoff_wait já devolveu não é reenviado', async () => {
    const id = seed('report')
    dormant('fail')
    const send = fakeQueue()
    await wakeMotherFor(id, 'reported')
    getDb().prepare('UPDATE handoff_wake_deliveries SET fetched_at = ?').run(Date.now())

    motherResumed()
    expect(await redeliverFailedWakes(NEW_MOTHER)).toBe(0)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('outra conversa não herda os wake_failed desta mãe', async () => {
    const id = seed('report')
    dormant('fail')
    fakeQueue()
    await wakeMotherFor(id, 'reported')
    getDb()
      .prepare(
        `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES ('stranger', 'r1', 'cc-other', 'running', 3)`,
      )
      .run()

    expect(await redeliverFailedWakes('stranger')).toBe(0)
  })
})

describe('pref sessions.lazyRestore desligada', () => {
  it('mãe dormindo: not_running de antes, sem wake nem transferência', async () => {
    getDb().prepare('DELETE FROM app_prefs WHERE key = ?').run(LAZY_RESTORE_PREF)
    const id = seed('ask')
    dormant('ok')
    const send = fakeQueue()

    await wakeMotherFor(id, 'asked')

    expect(wakeRequests).toEqual([])
    expect(send.mock.calls.map(([i]) => i.sessionId)).toEqual([OLD_MOTHER])
    expect(handoffStore.get(id)?.motherSessionId).toBe(OLD_MOTHER)
    expect(rows()).toEqual([
      { outcome: 'not_running', mother_session_id: OLD_MOTHER, detail: 'not-running' },
    ])
  })
})

describe('teto anti-loop (6/h) e mãe dormindo', () => {
  function fillCap(id: string, outcome: 'delivered' | 'wake_failed') {
    for (let i = 0; i < WAKE_CAP_PER_HANDOFF_PER_HOUR; i++) {
      insertRow({
        wakeId: `cap-${i}`,
        handoffId: id,
        mother: OLD_MOTHER,
        reason: 'reported',
        outcome,
      })
    }
  }

  function motherResumed() {
    getDb()
      .prepare(
        `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, 'r1', 'cc-mother', 'running', ?)`,
      )
      .run(NEW_MOTHER, Date.now())
  }

  it('wake_failed não conta no teto', async () => {
    const id = seed('report')
    fillCap(id, 'wake_failed')
    dormant('ok')
    const send = fakeQueue()

    await wakeMotherFor(id, 'reported')

    expect(send.mock.calls.map(([i]) => i.sessionId)).toEqual([OLD_MOTHER, NEW_MOTHER])
    expect(rows().filter((r) => r.outcome === 'capped')).toEqual([])
  })

  it('teto estourado com a mãe dormindo vira wake_failed e é reenviado quando ela volta', async () => {
    const id = seed('report')
    fillCap(id, 'delivered')
    dormant('ok')
    const send = fakeQueue()

    await wakeMotherFor(id, 'reported')

    expect(send).not.toHaveBeenCalled()
    expect(wakeRequests).toEqual([])
    expect(rows().at(-1)).toEqual({
      outcome: 'wake_failed',
      mother_session_id: OLD_MOTHER,
      detail: 'capped-while-dormant',
    })

    motherResumed()
    expect(await redeliverFailedWakes(NEW_MOTHER)).toBe(1)

    expect(send.mock.calls.map(([i]) => i.sessionId)).toEqual([NEW_MOTHER])
    expect(rows().at(-1)).toMatchObject({ outcome: 'delivered', mother_session_id: NEW_MOTHER })
  })

  it('teto estourado com a mãe sem pane dormindo segue capped', async () => {
    const id = seed('report')
    fillCap(id, 'delivered')
    const send = fakeQueue()

    await wakeMotherFor(id, 'reported')

    expect(send).not.toHaveBeenCalled()
    expect(rows().at(-1)).toMatchObject({ outcome: 'capped', detail: null })
  })

  it('pref desligada: capped como antes, mesmo com a pane registrada', async () => {
    getDb().prepare('DELETE FROM app_prefs WHERE key = ?').run(LAZY_RESTORE_PREF)
    const id = seed('report')
    fillCap(id, 'delivered')
    dormant('ok')
    fakeQueue()

    await wakeMotherFor(id, 'reported')

    expect(rows().at(-1)).toMatchObject({ outcome: 'capped', detail: null })
  })
})
