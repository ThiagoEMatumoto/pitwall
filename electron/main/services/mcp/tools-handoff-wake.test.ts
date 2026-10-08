/** @vitest-environment node */
// Integração do acordador da mãe pelos HANDLERS MCP reais: handoffs nascem no
// session_handoff da mãe (carimbo 'mother-1'), a filha chama ask/report/progress
// com o próprio carimbo, e a entrega passa por uma PromptQueue REAL cujo espelho
// de tela devolve ScreenScans produzidos pelo TuiMenuWatch real a partir de telas
// gravadas da CLI 2.1.286. O emit da fila liga no onQueueSnapshot, como em
// ipc/send-prompt.ts.
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-handoff-wake-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import * as handoffStore from '../handoff-store'
import { setPref } from '../prefs-store'
import { PromptQueue, SETTLE_MS } from '../prompt-queue'
import { setSpawnHandoffChild } from '../handoff/spawn-child'
import { __resetForTests, onQueueSnapshot, setHandoffWakeQueue } from '../handoff/handoff-wake'
import { fixture, scanOf } from '../test-support/screen-scans'
import {
  handoffAsking,
  type LiveStatus,
  type ScreenScan,
} from '../../../../shared/tui/attention-reason'
import { buildTools, type McpNotify, type McpRequestContext, type ToolResult } from './tools'

const MOTHER = 'mother-1'

const SCANS = {} as Record<'idle' | 'permission', ScreenScan>
beforeAll(async () => {
  SCANS.idle = await scanOf(fixture('claude-2.1.286-idle-prompt.ansi'))
  SCANS.permission = await scanOf(fixture('claude-2.1.286-permission-bash.ansi'))
})

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

// Estado da mãe visto pela fila: status nativo, tela espelhada, PTY viva.
const mother = {
  status: 'idle' as LiveStatus,
  scan: null as ScreenScan | null,
  running: true,
}
let writes: Array<{ id: string; text: string }> = []
let queue: PromptQueue

function seedRepo(label: string): void {
  const db = getDb()
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',1,1)`,
  ).run()
  db.prepare(
    'INSERT OR IGNORE INTO repos (id, project_id, label, path, role, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(`repo-${label}`, 'p1', label, `/repos/${label}`, null, 0, Date.now())
}

// A mãe despacha pelo handler real; devolve o handoffId e o sessions.id da filha.
async function dispatch(label: string): Promise<{ handoffId: string; child: string }> {
  seedRepo(label)
  const res = await callAs<{ handoffId: string; status: string }>(MOTHER, 'session_handoff', {
    targetRepo: label,
    task: `Tarefa em ${label}`,
    mode: 'plan',
  })
  expect(res.status).toBe('running')
  const child = handoffStore.get(res.handoffId)!.childSessionId!
  return { handoffId: res.handoffId, child }
}

interface Row {
  wake_id: string
  handoff_id: string
  outcome: string
  held_at: number | null
  delivered_at: number | null
  fetched_at: number | null
}
function rows(): Row[] {
  return getDb()
    .prepare('SELECT * FROM handoff_wake_deliveries ORDER BY created_at, rowid')
    .all() as Row[]
}

// Os handlers disparam o wake com `void`: deixa as promises e a fila andarem.
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
}

async function endMotherTurn(): Promise<void> {
  mother.status = 'idle'
  mother.scan = SCANS.idle
  queue.onTurnEnded(MOTHER)
  await vi.advanceTimersByTimeAsync(SETTLE_MS + 10)
  await settle()
}

beforeEach(() => {
  __resetForTests()
  const db = getDb()
  db.prepare('DELETE FROM handoff_wake_deliveries').run()
  db.prepare('DELETE FROM handoff_events').run()
  db.prepare('DELETE FROM handoffs').run()
  db.prepare('DELETE FROM sessions').run()
  // A mãe é uma sessão viva (o reconcileStuck do session_handoff olha sessions).
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
  mother.status = 'idle'
  mother.scan = SCANS.idle
  mother.running = true
  writes = []
  queue = new PromptQueue({
    isRunning: (id) => (id === MOTHER ? mother.running : true),
    status: () => mother.status,
    screen: async () => mother.scan,
    nativeStatus: () => true,
    // Mesmo predicado de ipc/send-prompt.ts.
    handoffAsking: (id) => {
      const h = handoffStore.getByChildSession(id)
      return h ? handoffAsking(h) : false
    },
    write: (id, text) => writes.push({ id, text }),
    emit: (s) => onQueueSnapshot(s),
    warn: () => {},
  })
  setHandoffWakeQueue({
    send: (i) => queue.send(i),
    replaceText: (id, t) => queue.replaceText(id, t),
  })
  // Timers falsos só depois dos scans (o xterm headless precisa dos reais).
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

describe('wake da mãe pelos handlers reais', () => {
  it('ask com a mãe idle: o envelope chega no REPL e a linha fica delivered', async () => {
    const { handoffId, child } = await dispatch('api')
    await callAs(child, 'handoff_ask', { handoffId, question: 'qual lib de validação?' })
    await settle()

    expect(writes).toHaveLength(1)
    expect(writes[0].id).toBe(MOTHER)
    expect(writes[0].text).toContain('<pitwall-handoff-update')
    expect(writes[0].text).toContain(handoffId)
    expect(writes[0].text).toContain('qual lib de validação?')
    expect(rows()).toMatchObject([{ handoff_id: handoffId, outcome: 'delivered' }])
    expect(rows()[0].delivered_at).toEqual(expect.any(Number))
  })

  it('menu aberto na mãe: segura sem escrever e entrega no fim do turno seguinte', async () => {
    const { handoffId, child } = await dispatch('api')
    mother.scan = SCANS.permission
    await callAs(child, 'handoff_ask', { handoffId, question: 'posso apagar a tabela?' })
    await settle()

    expect(writes).toEqual([])
    expect(rows()).toMatchObject([{ outcome: 'held' }])
    expect(rows()[0].held_at).toEqual(expect.any(Number))

    await endMotherTurn()
    expect(writes).toHaveLength(1)
    expect(rows()).toMatchObject([{ outcome: 'delivered' }])
  })

  it('rajada de 3 reports com a mãe trabalhando vira UM envelope e uma escrita', async () => {
    const a = await dispatch('api')
    const b = await dispatch('web')
    const c = await dispatch('infra')
    mother.status = 'working'
    for (const h of [a, b, c]) {
      await callAs(h.child, 'handoff_report', {
        handoffId: h.handoffId,
        summary: `feito ${h.handoffId}`,
      })
    }
    await settle()

    expect(writes).toEqual([])
    const all = rows()
    expect(all).toHaveLength(3)
    expect(new Set(all.map((r) => r.wake_id)).size).toBe(1)
    expect(queue.snapshot().items.filter((i) => i.sessionId === MOTHER)).toHaveLength(1)

    await endMotherTurn()
    expect(writes).toHaveLength(1)
    for (const h of [a, b, c]) expect(writes[0].text).toContain(h.handoffId)
    expect(rows().every((r) => r.outcome === 'delivered')).toBe(true)
  })

  it('handoff_progress não acorda: nenhuma linha, nenhum item, nenhuma escrita', async () => {
    const { handoffId, child } = await dispatch('api')
    await callAs(child, 'handoff_progress', { handoffId, step: 'lendo o código' })
    await settle()
    expect(rows()).toEqual([])
    expect(queue.snapshot().items).toEqual([])
    expect(writes).toEqual([])
  })

  it('report duplicado não gera linha nova', async () => {
    const { handoffId, child } = await dispatch('api')
    await callAs(child, 'handoff_report', { handoffId, summary: 'pronto' })
    await settle()
    await callAs(child, 'handoff_report', { handoffId, summary: 'pronto de novo' })
    await settle()
    expect(rows()).toHaveLength(1)
  })

  it('mãe sem espelho (Codex) vira no_screen', async () => {
    const { handoffId, child } = await dispatch('api')
    mother.scan = null
    await callAs(child, 'handoff_report', { handoffId, summary: 'pronto' })
    await settle()
    expect(rows()).toMatchObject([{ outcome: 'no_screen' }])
    expect(writes).toEqual([])
  })

  it('mãe encerrada vira not_running', async () => {
    const { handoffId, child } = await dispatch('api')
    mother.running = false
    await callAs(child, 'handoff_report', { handoffId, summary: 'pronto' })
    await settle()
    expect(rows()).toMatchObject([{ outcome: 'not_running' }])
  })

  it('mãe que é filha em needs_input vira attention, sem escrita', async () => {
    // A mãe é ela mesma filha de outro handoff, bloqueada numa pergunta.
    seedRepo('avo')
    const outer = handoffStore.create({
      targetRepoId: 'repo-avo',
      task: 't',
      composedPrompt: 'p',
      motherSessionId: 'grandma',
    })
    handoffStore.approve(outer.id, {})
    handoffStore.markRunning(outer.id, MOTHER)
    handoffStore.ask(outer.id, 'avó, e agora?')

    const { handoffId, child } = await dispatch('api')
    await callAs(child, 'handoff_report', { handoffId, summary: 'pronto' })
    await settle()
    expect(rows().filter((r) => r.handoff_id === handoffId)).toMatchObject([
      { outcome: 'attention' },
    ])
    expect(writes.filter((w) => w.id === MOTHER)).toEqual([])
  })
})

describe('handoff_list por mãe', () => {
  it('a mother-1 não vê o handoff da mother-2; limit corta', async () => {
    await dispatch('api')
    await dispatch('web')
    seedRepo('outro')
    const other = await callAs<{ handoffId: string }>('mother-2', 'session_handoff', {
      targetRepo: 'outro',
      task: 'da outra mãe',
      mode: 'plan',
    })
    const mine = await callAs<{ items: Array<{ handoffId: string }> }>(MOTHER, 'handoff_list', {})
    expect(mine.items).toHaveLength(2)
    expect(mine.items.map((i) => i.handoffId)).not.toContain(other.handoffId)
    const one = await callAs<{ items: unknown[] }>(MOTHER, 'handoff_list', { limit: 1 })
    expect(one.items).toHaveLength(1)
    const all = await callAs<{ items: unknown[] }>(MOTHER, 'handoff_list', { scope: 'all' })
    expect(all.items).toHaveLength(3)
  })
})

describe('handoff_wait (fallback pull)', () => {
  type Wait = { updates: Array<{ handoffId: string; reason: string; body: string }>; timedOut: boolean }

  it('mãe sem espelho: o ask já ocorrido volta de imediato e não volta de novo', async () => {
    const { handoffId, child } = await dispatch('api')
    mother.scan = null
    await callAs(child, 'handoff_ask', { handoffId, question: 'qual banco?' })
    await settle()
    expect(rows()).toMatchObject([{ outcome: 'no_screen', fetched_at: null }])

    const first = await callAs<Wait>(MOTHER, 'handoff_wait', {})
    expect(first.updates).toMatchObject([{ handoffId, reason: 'asked', body: 'qual banco?' }])
    expect(rows()[0].fetched_at).toEqual(expect.any(Number))

    const second = await callAs<Wait>(MOTHER, 'handoff_wait', { waitSeconds: 0 })
    expect(second.updates).toEqual([])
  })

  it('espera pendente resolve com o ask da filha antes do prazo', async () => {
    const { handoffId, child } = await dispatch('api')
    mother.scan = null
    const pending = callAs<Wait>(MOTHER, 'handoff_wait', { waitSeconds: 30 })
    await settle()
    await callAs(child, 'handoff_ask', { handoffId, question: 'e o deploy?' })
    await settle()
    const res = await pending
    expect(res.timedOut).toBe(false)
    expect(res.updates).toMatchObject([{ handoffId, reason: 'asked' }])
  })

  it('sem carimbo: erro legível', async () => {
    await expect(callAs(null, 'handoff_wait', {})).rejects.toThrow(/identidade da sessão/)
  })
})
