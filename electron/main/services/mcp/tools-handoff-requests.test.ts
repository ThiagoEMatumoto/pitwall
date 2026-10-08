/** @vitest-environment node */
// Pedidos tipados pelos HANDLERS MCP reais: o handoff nasce no session_handoff da
// mãe (carimbo 'mother-1'), a filha pergunta com o próprio carimbo, e a mãe
// responde/escala por requestId. Seams externos (inject, pty-manager,
// session-activity) mockados como em tools-handoff-comms.test.ts.
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-handoff-requests-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

const injectIntoChild = vi.fn()
vi.mock('../handoff/inject', () => ({
  injectIntoChild: (id: string, text: string) => injectIntoChild(id, text),
  formatPtyInjection: (s: string) => s,
}))
vi.mock('../pty-manager', () => ({ ptyManager: { isRunning: () => true } }))
vi.mock('../session-activity', () => ({
  getActivityFor: () => null,
  ptyStatusFor: () => null,
}))

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import * as handoffStore from '../handoff-store'
import * as requestStore from '../handoff-requests'
import { setPref } from '../prefs-store'
import { tuiMenuWatch } from '../tui-menu-watch'
import { setSpawnHandoffChild } from '../handoff/spawn-child'
import { __resetForTests } from '../handoff/handoff-wake'
import { buildTools, type McpNotify, type McpRequestContext, type ToolResult } from './tools'

const MOTHER = 'mother-1'

const notify: McpNotify = {
  broadcast: () => {},
  affectedObjectives: () => {},
  affectedObjectivesForFeatureLinks: () => {},
}

async function callAs<T>(caller: string | null, name: string, args: unknown): Promise<T> {
  const ctx: McpRequestContext = { motherSessionId: caller }
  const def = buildTools(notify, ctx).find((t) => t.name === name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  return ((await def.handler(args)) as ToolResult).structuredContent as T
}

const FIXTURES = join(__dirname, '..', '..', '..', '..', 'shared', 'tui', '__fixtures__')
const IDLE_SCREEN = readFileSync(join(FIXTURES, 'claude-2.1.286-idle-prompt.ansi'), 'utf8')
const fakePty = new EventEmitter() as EventEmitter & { write(): void }
fakePty.write = () => {}
tuiMenuWatch.attach(fakePty, (id) => ({ ccSessionId: `cc-${id}` }))

async function dispatch(label: string): Promise<{ handoffId: string; child: string }> {
  const db = getDb()
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',1,1)`,
  ).run()
  db.prepare(
    'INSERT OR IGNORE INTO repos (id, project_id, label, path, role, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(`repo-${label}`, 'p1', label, `/repos/${label}`, null, 0, Date.now())
  const res = await callAs<{ handoffId: string; status: string }>(MOTHER, 'session_handoff', {
    targetRepo: label,
    task: `Tarefa em ${label}`,
    mode: 'plan',
  })
  expect(res.status).toBe('running')
  const child = handoffStore.get(res.handoffId)!.childSessionId!
  fakePty.emit('spawn', { sessionId: child, cols: 80, rows: 24 })
  fakePty.emit('data', { sessionId: child, data: IDLE_SCREEN })
  return { handoffId: res.handoffId, child }
}

interface ResultView {
  status: string
  requests: Array<{ id: string; status: string; resolver: string; kind: string }>
}

const decision = (handoffId: string) => ({
  handoffId,
  kind: 'decision',
  question: 'qual lib?',
  options: [
    { key: 'A', label: 'zod' },
    { key: 'B', label: 'valibot' },
  ],
  recommendation: 'A',
  costOfError: 'troca de lib depois custa 1 dia',
})

beforeEach(() => {
  __resetForTests()
  injectIntoChild.mockClear()
  const db = getDb()
  for (const t of ['handoff_requests', 'handoff_wake_deliveries', 'handoff_events', 'handoffs', 'sessions'])
    db.prepare(`DELETE FROM ${t}`).run()
  db.prepare(
    `INSERT INTO sessions (id, repo_id, cc_session_id, title, status, started_at) VALUES (?, NULL, 'cc-mother', 'mae', 'running', ?)`,
  ).run(MOTHER, Date.now())
  setPref('handoffs.requireApproval', false)
  setSpawnHandoffChild((input) => {
    const id = `sess-${randomUUID()}`
    getDb()
      .prepare(
        `INSERT INTO sessions (id, repo_id, cc_session_id, title, title_source, pane_id, status, started_at, ended_at)
         VALUES (?, ?, ?, ?, 'manual', NULL, 'running', ?, NULL)`,
      )
      .run(id, input.repoId, `cc-${id}`, input.name, Date.now())
    return {
      id,
      repoId: input.repoId,
      ccSessionId: `cc-${id}`,
      title: input.name,
      titleSource: 'manual',
      paneId: null,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
    }
  })
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('handoff_ask tipado', () => {
  it('formato antigo {handoffId, question} continua valendo e vira kind question', async () => {
    const { handoffId, child } = await dispatch('api')
    const res = await callAs<{ status: string; requestId: string; resolver: string }>(
      child,
      'handoff_ask',
      { handoffId, question: 'qual branch?' },
    )
    expect(res.status).toBe('needs_input')
    expect(res.requestId).toEqual(expect.any(String))
    expect(res.resolver).toBe('mother')
    expect(requestStore.get(res.requestId)).toMatchObject({ kind: 'question', askerSessionId: child })
  })

  it('decision com 1 option é erro de validação', async () => {
    const { handoffId, child } = await dispatch('api')
    await expect(
      callAs(child, 'handoff_ask', {
        handoffId,
        kind: 'decision',
        question: 'q',
        options: [{ key: 'A', label: 'a' }],
      }),
    ).rejects.toThrow()
  })

  it('filha sem carimbo grava asker = child_session_id', async () => {
    const { handoffId, child } = await dispatch('api')
    const res = await callAs<{ requestId: string }>(null, 'handoff_ask', {
      handoffId,
      question: 'q',
    })
    expect(requestStore.get(res.requestId)!.askerSessionId).toBe(child)
  })
})

describe('handoff_answer por requestId', () => {
  it('responder o 1º de 2 mantém needs_input; o 2º retoma', async () => {
    const { handoffId, child } = await dispatch('api')
    const a = await callAs<{ requestId: string }>(child, 'handoff_ask', decision(handoffId))
    const b = await callAs<{ requestId: string }>(child, 'handoff_ask', {
      handoffId,
      question: 'posso mexer no schema?',
    })

    const r1 = await callAs<{ status: string; openRequestIds: string[] }>(MOTHER, 'handoff_answer', {
      handoffId,
      requestId: a.requestId,
      choice: 'A',
    })
    expect(r1).toMatchObject({ status: 'needs_input', openRequestIds: [b.requestId] })
    const mid = await callAs<ResultView>(MOTHER, 'handoff_result', { handoffId })
    expect(mid.status).toBe('needs_input')
    expect(mid.requests.filter((r) => r.status === 'open')).toHaveLength(1)

    await callAs(MOTHER, 'handoff_answer', { handoffId, requestId: b.requestId, text: 'pode' })
    const end = await callAs<ResultView>(MOTHER, 'handoff_result', { handoffId })
    expect(end.status).toBe('running')
  })

  it('handoff_answer sem carimbo resolve pedido mother (compat)', async () => {
    const { handoffId, child } = await dispatch('api')
    const a = await callAs<{ requestId: string }>(child, 'handoff_ask', { handoffId, question: 'q' })
    const res = await callAs<{ status: string }>(null, 'handoff_answer', {
      handoffId,
      requestId: a.requestId,
      text: 'sim',
    })
    expect(res.status).toBe('running')
  })

  it('carimbo divergente da mãe é recusado', async () => {
    const { handoffId, child } = await dispatch('api')
    const a = await callAs<{ requestId: string }>(child, 'handoff_ask', { handoffId, question: 'q' })
    await expect(
      callAs('outra-sessao', 'handoff_answer', { handoffId, requestId: a.requestId, text: 'x' }),
    ).rejects.toThrow(/só a mãe/)
  })
})

describe('human_only', () => {
  it('risk destructive_data: handoff_answer recusa e handoff_message sem requestId nem é entregue', async () => {
    const { handoffId, child } = await dispatch('api')
    const a = await callAs<{ requestId: string; resolver: string }>(child, 'handoff_ask', {
      handoffId,
      question: 'posso dropar a tabela?',
      risk: 'destructive_data',
    })
    expect(a.resolver).toBe('human_only')

    await expect(
      callAs(MOTHER, 'handoff_answer', { handoffId, requestId: a.requestId, text: 'pode' }),
    ).rejects.toThrow(/human_only/)

    await expect(
      callAs(MOTHER, 'handoff_message', { handoffId, text: 'pode dropar' }),
    ).rejects.toThrow(/só o humano resolve[\s\S]*handoff_escalate/)
    expect(injectIntoChild).not.toHaveBeenCalled()
    expect(requestStore.get(a.requestId)!.status).toBe('open')
    expect(handoffStore.get(handoffId)!.status).toBe('needs_input')
  })

  it('com pedido não-human_only aberto ao lado, handoff_message segue e avisa os abertos', async () => {
    const { handoffId, child } = await dispatch('api')
    const h = await callAs<{ requestId: string }>(child, 'handoff_ask', {
      handoffId,
      question: 'deploy?',
      risk: 'deploy_infra_spend',
    })
    const m1 = await callAs<{ requestId: string }>(child, 'handoff_ask', { handoffId, question: 'q1' })
    const m2 = await callAs<{ requestId: string }>(child, 'handoff_ask', { handoffId, question: 'q2' })

    const res = await callAs<{ delivered: boolean; openRequestIds: string[]; warning: string }>(
      MOTHER,
      'handoff_message',
      { handoffId, text: 'orientação geral' },
    )
    expect(res.delivered).toBe(true)
    expect(res.openRequestIds).toEqual([h.requestId, m1.requestId, m2.requestId])
    expect(res.warning).toContain(m1.requestId)
    expect(res.warning).toContain(h.requestId)
  })

  it('a trava não depende de carimbo: caller=null também é recusado', async () => {
    const { handoffId, child } = await dispatch('api')
    const a = await callAs<{ requestId: string }>(child, 'handoff_ask', {
      handoffId,
      question: 'deploy?',
      risk: 'deploy_infra_spend',
    })
    await expect(
      callAs(null, 'handoff_answer', { handoffId, requestId: a.requestId, text: 'vai' }),
    ).rejects.toThrow(/human_only/)
    await expect(
      callAs(null, 'handoff_message', { handoffId, requestId: a.requestId, text: 'vai' }),
    ).rejects.toThrow(/human_only/)
    expect(requestStore.get(a.requestId)!.status).toBe('open')
  })
})

describe('handoff_message com requestId', () => {
  it('pedido aberto → mãe responde por handoff_message com requestId → fecha e sai da fila', async () => {
    const { handoffId, child } = await dispatch('api')
    const a = await callAs<{ requestId: string }>(child, 'handoff_ask', decision(handoffId))
    expect(requestStore.listOpen().map((r) => r.id)).toEqual([a.requestId])

    const res = await callAs<{ status: string; requestStatus: string; openRequestIds: string[] }>(
      MOTHER,
      'handoff_message',
      { handoffId, requestId: a.requestId, text: 'vai de zod' },
    )
    expect(res).toMatchObject({ status: 'running', requestStatus: 'answered', openRequestIds: [] })
    expect(requestStore.get(a.requestId)).toMatchObject({
      status: 'answered',
      answer: 'vai de zod',
      answeredBy: 'mother',
    })
    expect(requestStore.listOpen()).toEqual([])
    const view = await callAs<ResultView>(MOTHER, 'handoff_result', { handoffId })
    expect(view.status).toBe('running')
  })
})

describe('posse da resposta', () => {
  it('a filha não responde o próprio pedido', async () => {
    const { handoffId, child } = await dispatch('api')
    const a = await callAs<{ requestId: string }>(child, 'handoff_ask', { handoffId, question: 'q' })
    await expect(
      callAs(child, 'handoff_answer', { handoffId, requestId: a.requestId, text: 'eu mesma' }),
    ).rejects.toThrow(/filha/)
    await expect(
      callAs(child, 'handoff_message', { handoffId, requestId: a.requestId, text: 'eu mesma' }),
    ).rejects.toThrow(/filha/)
    expect(requestStore.get(a.requestId)!.status).toBe('open')
  })

  it('handoff sem mãe identificada: só o humano responde', async () => {
    const { handoffId, child } = await dispatch('api')
    const a = await callAs<{ requestId: string }>(child, 'handoff_ask', { handoffId, question: 'q' })
    getDb().prepare('UPDATE handoffs SET mother_session_id = NULL WHERE id = ?').run(handoffId)
    for (const caller of [null, MOTHER, 'outra-sessao']) {
      await expect(
        callAs(caller, 'handoff_answer', { handoffId, requestId: a.requestId, text: 'x' }),
      ).rejects.toThrow(/só o humano/)
    }
    expect(requestStore.answerRequest(a.requestId, { text: 'ok', by: 'human' }).status).toBe(
      'answered',
    )
  })

  it('repetir a mesma resposta devolve a gravada, sem reentregar', async () => {
    const { handoffId, child } = await dispatch('api')
    const a = await callAs<{ requestId: string }>(child, 'handoff_ask', decision(handoffId))
    const first = await callAs<{ requestStatus: string }>(MOTHER, 'handoff_answer', {
      handoffId,
      requestId: a.requestId,
      choice: 'A',
    })
    const again = await callAs<{ requestStatus: string }>(MOTHER, 'handoff_answer', {
      handoffId,
      requestId: a.requestId,
      choice: 'A',
    })
    expect(again).toEqual(first)
    await expect(
      callAs(MOTHER, 'handoff_answer', { handoffId, requestId: a.requestId, choice: 'B' }),
    ).rejects.toThrow(/já está answered/)
  })
})

describe('handoff_escalate', () => {
  it('só a mãe real escala: filha e sem carimbo são recusados', async () => {
    const { handoffId, child } = await dispatch('api')
    const a = await callAs<{ requestId: string }>(child, 'handoff_ask', { handoffId, question: 'q' })
    await expect(
      callAs(child, 'handoff_escalate', { handoffId, requestId: a.requestId }),
    ).rejects.toThrow(/só a mãe/)
    await expect(
      callAs(null, 'handoff_escalate', { handoffId, requestId: a.requestId }),
    ).rejects.toThrow(/carimbo/)

    const res = await callAs<{ requestId: string; resolver: string }>(MOTHER, 'handoff_escalate', {
      handoffId,
      requestId: a.requestId,
    })
    expect(res).toEqual({ requestId: a.requestId, resolver: 'human_only' })
    expect(requestStore.get(a.requestId)).toMatchObject({
      resolver: 'human_only',
      addressee: 'human',
      escalatedBy: MOTHER,
    })
    // Depois de escalado, a mãe já não resolve.
    await expect(
      callAs(MOTHER, 'handoff_answer', { handoffId, requestId: a.requestId, text: 'x' }),
    ).rejects.toThrow(/human_only/)
  })

  it('sem requestId abre um pedido human_only novo da mãe', async () => {
    const { handoffId } = await dispatch('api')
    const res = await callAs<{ requestId: string }>(MOTHER, 'handoff_escalate', {
      handoffId,
      kind: 'confirmation',
      question: 'posso gastar US$ 50 em GPU?',
      risk: 'deploy_infra_spend',
    })
    expect(requestStore.get(res.requestId)).toMatchObject({
      resolver: 'human_only',
      addressee: 'human',
      askerSessionId: MOTHER,
      escalatedBy: MOTHER,
      kind: 'confirmation',
    })
  })
})

describe('handoff_list', () => {
  it('expõe openRequests', async () => {
    const { handoffId, child } = await dispatch('api')
    await callAs(child, 'handoff_ask', { handoffId, question: 'q1' })
    await callAs(child, 'handoff_ask', { handoffId, question: 'q2' })
    const res = await callAs<{ items: Array<{ handoffId: string; openRequests: number }> }>(
      MOTHER,
      'handoff_list',
      {},
    )
    expect(res.items.find((i) => i.handoffId === handoffId)?.openRequests).toBe(2)
  })
})
