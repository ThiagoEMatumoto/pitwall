import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './migrations/index'

let testDb: Database.Database
vi.mock('./db', () => ({ getDb: () => testDb }))
vi.mock('./transcript-path', () => ({ findTranscriptPath: () => null }))

import * as store from './handoff-store'
import * as requests from './handoff-requests'
import { HumanOnlyError } from './handoff-requests'

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

function runningHandoff(repo = 'r1') {
  const h = store.create({ targetRepoId: repo, task: 't', composedPrompt: 'p' })
  store.approve(h.id, {})
  return store.markRunning(h.id, `child-${repo}`)
}

function events(handoffId: string): string[] {
  return (
    testDb
      .prepare('SELECT event FROM handoff_events WHERE handoff_id = ? ORDER BY at, rowid')
      .all(handoffId) as Array<{ event: string }>
  ).map((e) => e.event)
}

function requestStatus(id: string): string {
  return requests.get(id)!.status
}

describe('handoff-requests (pelo produtor real)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    testDb.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',1,1)`).run()
    testDb
      .prepare(
        `INSERT INTO repos (id, project_id, label, path, position, created_at)
         VALUES ('r1','p1','R1','/tmp/r1',0,1), ('r2','p1','R2','/tmp/r2',1,1)`,
      )
      .run()
  })

  afterEach(() => testDb.close())

  it('(a)(b)(c) responder um de dois mantém needs_input; o último retoma', () => {
    const h = runningHandoff()
    const a = store.ask(h.id, { kind: 'decision', question: 'qual lib?', options: [
      { key: 'A', label: 'zod' },
      { key: 'B', label: 'valibot' },
    ], recommendation: 'A' }, 'child-r1')
    const b = store.ask(h.id, 'posso mexer no schema?', 'child-r1')

    expect(b.handoff.status).toBe('needs_input')
    expect(b.handoff.pendingQuestion).toBe('qual lib?\n\nposso mexer no schema?')
    expect(requests.listOpen({ handoffId: h.id })).toHaveLength(2)
    expect(a.request!.askerSessionId).toBe('child-r1')

    requests.answerRequest(a.request!.id, { choice: 'A', text: 'vai de zod', by: 'mother' })
    const mid = store.get(h.id)!
    expect(mid.status).toBe('needs_input')
    expect(mid.pendingQuestion).toBe('posso mexer no schema?')
    expect(mid.questionAskedAt).toBe(b.request!.createdAt)
    expect(requests.get(a.request!.id)).toMatchObject({
      status: 'answered',
      answer: 'A',
      answerNote: 'vai de zod',
      answeredBy: 'mother',
    })

    requests.answerRequest(b.request!.id, { text: 'pode', by: 'human' })
    const end = store.get(h.id)!
    expect(end.status).toBe('running')
    expect(end.pendingQuestion).toBeNull()
    expect(end.questionAskedAt).toBeNull()
    expect(events(h.id)).toContain('resume')
    expect(events(h.id).filter((e) => e === 'request_answer')).toHaveLength(2)
  })

  it('choice fora das options é recusada', () => {
    const h = runningHandoff()
    const { request } = store.ask(h.id, { kind: 'decision', question: 'q', options: [
      { key: 'A', label: 'a' },
      { key: 'B', label: 'b' },
    ] })
    expect(() => requests.answerRequest(request!.id, { choice: 'C', by: 'mother' })).toThrow(/inválida/)
    expect(requestStatus(request!.id)).toBe('open')
  })

  it('(d) risk deploy_infra_spend ⇒ human_only: a mãe não resolve, o humano sim', () => {
    const h = runningHandoff()
    const { request } = store.ask(h.id, { question: 'posso fazer deploy?', risk: 'deploy_infra_spend' })
    expect(request).toMatchObject({ resolver: 'human_only', addressee: 'human' })
    expect(() => requests.answerRequest(request!.id, { text: 'vai', by: 'mother' })).toThrow(
      HumanOnlyError,
    )
    expect(requestStatus(request!.id)).toBe('open')
    // resume sem requestId também não fecha human_only.
    const res = store.resume(h.id, { text: 'vai', by: 'mother' })
    expect(res.closedRequestId).toBeNull()
    expect(res.openRequestIds).toEqual([request!.id])
    expect(res.handoff.status).toBe('needs_input')

    requests.answerRequest(request!.id, { text: 'pode', by: 'human' })
    expect(requestStatus(request!.id)).toBe('answered')
    expect(store.get(h.id)!.status).toBe('running')
  })

  it('resume fecha só com exatamente 1 aberto', () => {
    const h = runningHandoff()
    store.ask(h.id, 'q1')
    store.ask(h.id, 'q2')
    const two = store.resume(h.id, { text: 'x' })
    expect(two.closedRequestId).toBeNull()
    expect(two.openRequestIds).toHaveLength(2)
    expect(two.handoff.status).toBe('needs_input')
  })

  it('(e) mesma idempotencyKey 2× ⇒ 1 linha, created=false', () => {
    const h = runningHandoff()
    const first = store.ask(h.id, { question: 'q', idempotencyKey: 'k1' })
    const second = store.ask(h.id, { question: 'q', idempotencyKey: 'k1' })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.request!.id).toBe(first.request!.id)
    expect(requests.listFor(h.id)).toHaveLength(1)
    expect(events(h.id).filter((e) => e === 'ask')).toHaveLength(1)
  })

  it('(f) report/release/create(force) cancelam os pedidos abertos', () => {
    const reported = runningHandoff('r1')
    const r1 = store.ask(reported.id, 'q').request!
    store.report(reported.id, 'feito')
    expect(requestStatus(r1.id)).toBe('cancelled')
    expect(events(reported.id)).toContain('request_cancel')

    const released = runningHandoff('r1')
    const r2 = store.ask(released.id, { question: 'deploy?', risk: 'deploy_infra_spend' }).request!
    expect(store.release(released.id).status).toBe('interrupted')
    expect(requestStatus(r2.id)).toBe('cancelled')

    const old = runningHandoff('r2')
    const r3 = store.ask(old.id, 'q').request!
    store.create(
      { targetRepoId: 'r2', task: 't2', composedPrompt: 'p' },
      { force: { reason: 'troca' } },
    )
    expect(store.get(old.id)!.status).toBe('interrupted')
    expect(requestStatus(r3.id)).toBe('cancelled')
  })

  it('fail e failIfRunning também cancelam', () => {
    const a = runningHandoff('r1')
    const ra = store.ask(a.id, 'q').request!
    store.fail(a.id, 'erro')
    expect(requestStatus(ra.id)).toBe('cancelled')

    const b = runningHandoff('r1')
    const rb = store.ask(b.id, 'q').request!
    store.failIfRunning(b.id, 'pty morreu')
    expect(requestStatus(rb.id)).toBe('cancelled')
  })

  it('(g) dismiss/snooze não mexem em handoffs nem em handoff_requests', () => {
    const h = runningHandoff()
    const { request } = store.ask(h.id, 'q')
    const key = `request:${request!.id}`
    requests.dismissAttention(key, request!.id)
    expect(store.get(h.id)!.status).toBe('needs_input')
    expect(requestStatus(request!.id)).toBe('open')
    expect(requests.activeDismissals(Date.now()).get(key)?.action).toBe('dismiss')

    requests.snoozeAttention(key, request!.id, 1_000)
    expect(requests.activeDismissals(500).get(key)).toEqual({ action: 'snooze', snoozedUntil: 1_000 })
    // Snooze vencido não volta no mapa.
    expect(requests.activeDismissals(2_000).has(key)).toBe(false)
    expect(requestStatus(request!.id)).toBe('open')
  })

  it('escalateRequest passa a human_only e grava quem escalou', () => {
    const h = runningHandoff()
    const { request } = store.ask(h.id, 'q')
    const esc = requests.escalateRequest(request!.id, 'mother-1')
    expect(esc).toMatchObject({ resolver: 'human_only', addressee: 'human', escalatedBy: 'mother-1' })
    expect(esc.escalatedAt).not.toBeNull()
    expect(events(h.id)).toContain('request_escalate')
  })

  it('ask fora do estado vivo não cria pedido', () => {
    const h = store.create({ targetRepoId: 'r1', task: 't', composedPrompt: 'p' })
    const res = store.ask(h.id, 'cedo')
    expect(res.request).toBeNull()
    expect(requests.listFor(h.id)).toHaveLength(0)
  })
})
