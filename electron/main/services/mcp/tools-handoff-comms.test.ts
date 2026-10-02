/** @vitest-environment node */
// Unit dos handlers MCP do canal bidirecional de handoff (handoff_message /
// handoff_ask / enriquecimento do handoff_result). DB better-sqlite3 real (tmp),
// electron mockado, e os seams externos (inject.ts, pty-manager, session-activity)
// mockados — o foco é o contrato dos guards e da transição de status.
import { EventEmitter } from 'node:events'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-handoff-comms-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

// Seam de injeção: espiamos a entrega sem tocar num PTY real.
const injectIntoChild = vi.fn()
vi.mock('../handoff/inject', () => ({
  injectIntoChild: (id: string, text: string) => injectIntoChild(id, text),
  formatPtyInjection: (s: string) => s,
}))

// PTY vivo? controlável por teste.
const isRunning = vi.fn((_id: string) => true)
vi.mock('../pty-manager', () => ({
  ptyManager: { isRunning: (id: string) => isRunning(id) },
}))

// Atividade ao vivo da filha: snapshot fixo pro enriquecimento do handoff_result.
vi.mock('../session-activity', () => ({
  getActivityFor: () => ({
    status: 'working',
    lastActivityAt: 123,
    lastText: 'editando arquivo',
    tokens: { output: 10, context: 200 },
  }),
}))

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import * as handoffStore from '../handoff-store'
import { tuiMenuWatch } from '../tui-menu-watch'
import { onSessionLinkPulse } from '../session-link-pulse'
import { setSpawnHandoffChild } from '../handoff/spawn-child'
import type { SessionLinkPulse } from '../../../../shared/types/session-link-pulse'
import {
  buildTools,
  type McpNotify,
  type McpRequestContext,
  type ToolDef,
  type ToolResult,
} from './tools'

function makeNotify(): McpNotify {
  return {
    broadcast: () => {},
    affectedObjectives: () => {},
    affectedObjectivesForFeatureLinks: () => {},
  }
}

let tools: ToolDef[]

function tool(name: string): ToolDef {
  const def = tools.find((t) => t.name === name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  return def
}

function call<T>(name: string, args: unknown): T {
  return (tool(name).handler(args) as ToolResult).structuredContent as T
}

// Mesma bateria de tools, mas com o carimbo de identidade que o app põe no spawn
// (?s=<sessions.id>) — é ele que diz QUEM está chamando.
function callAs<T>(callerSessionId: string | null, name: string, args: unknown): T {
  const ctx: McpRequestContext = { motherSessionId: callerSessionId }
  const def = buildTools(makeNotify(), ctx).find((t) => t.name === name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  return (def.handler(args) as ToolResult).structuredContent as T
}

async function callAsync<T>(name: string, args: unknown): Promise<T> {
  return ((await tool(name).handler(args)) as ToolResult).structuredContent as T
}

// Telas REAIS do claude 2.1.286 no espelho headless de produção (o singleton que
// o handoff_message consulta): o guard lê o ScreenScan que o produtor devolve.
const FIXTURES = join(__dirname, '..', '..', '..', '..', 'shared', 'tui', '__fixtures__')
const IDLE_SCREEN = readFileSync(join(FIXTURES, 'claude-2.1.286-idle-prompt.ansi'), 'utf8')
const PERMISSION_SCREEN = readFileSync(
  join(FIXTURES, 'claude-2.1.286-permission-bash.ansi'),
  'utf8',
)
const fakePty = new EventEmitter() as EventEmitter & { write(): void }
fakePty.write = () => {}
tuiMenuWatch.attach(fakePty, (id) => (id.startsWith('codex') ? null : { ccSessionId: `cc-${id}` }))

function showScreen(sessionId: string, ansi: string): void {
  fakePty.emit('exit', { sessionId, exitCode: 0 })
  fakePty.emit('spawn', { sessionId, cols: 80, rows: 24 })
  fakePty.emit('data', { sessionId, data: ansi })
}

// Cria um handoff running com filha atrelada (sessions.id + cc_session_id).
function seedRunningHandoff(childSessionId = 's-child'): string {
  if (!childSessionId.startsWith('codex')) showScreen(childSessionId, IDLE_SCREEN)
  const db = getDb()
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)`,
  ).run(Date.now(), Date.now())
  db.prepare(
    `INSERT OR IGNORE INTO repos (id, project_id, label, path, position, created_at) VALUES ('r1','p1','R1','/tmp/r1',0,?)`,
  ).run(Date.now())
  db.prepare(
    `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES (?, 'r1', ?, 'running', ?)`,
  ).run(childSessionId, `cc-${childSessionId}`, Date.now())
  const h = handoffStore.create({
    targetRepoId: 'r1',
    task: 't',
    composedPrompt: 'p',
  })
  handoffStore.approve(h.id, {})
  handoffStore.markRunning(h.id, childSessionId)
  return h.id
}

beforeEach(() => {
  tools = buildTools(makeNotify())
  injectIntoChild.mockClear()
  isRunning.mockClear()
  isRunning.mockReturnValue(true)
  // Limpa handoffs/sessions entre casos (DB persiste no processo).
  const db = getDb()
  db.prepare('DELETE FROM handoffs').run()
  db.prepare('DELETE FROM sessions').run()
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('handoff_ask (filha → mãe)', () => {
  it('grava a pergunta e move pra needs_input', () => {
    const id = seedRunningHandoff()
    const res = call<{ status: string; pendingQuestion: string }>('handoff_ask', {
      handoffId: id,
      question: 'qual lib de validação?',
    })
    expect(res.status).toBe('needs_input')
    expect(res.pendingQuestion).toBe('qual lib de validação?')
  })

  it('404 quando o handoff não existe', () => {
    expect(() => call('handoff_ask', { handoffId: 'nope', question: 'x' })).toThrow(
      /não encontrado/,
    )
  })
})

describe('handoff_message (mãe → filha)', () => {
  it('entrega a mensagem, retoma a filha (needs_input → running) e espia inject', async () => {
    const id = seedRunningHandoff()
    handoffStore.ask(id, 'pergunta')
    const res = await callAsync<{ status: string; delivered: boolean }>('handoff_message', {
      handoffId: id,
      text: 'use zod',
    })
    expect(res.delivered).toBe(true)
    expect(res.status).toBe('running')
    expect(injectIntoChild).toHaveBeenCalledWith('s-child', 'use zod')
  })

  it('menu de permissão aberto na tela da filha: recusa sem escrever e mantém a pergunta', async () => {
    const id = seedRunningHandoff('s-menu')
    handoffStore.ask(id, 'pergunta')
    showScreen('s-menu', PERMISSION_SCREEN)
    await expect(callAsync('handoff_message', { handoffId: id, text: 'status?' })).rejects.toThrow(
      /menu aberto/,
    )
    expect(injectIntoChild).not.toHaveBeenCalled()
    expect(handoffStore.get(id)?.status).toBe('needs_input')
  })

  it('filha sem espelho da tela (Codex): recusa — o Enter aprovaria o overlay', async () => {
    const id = seedRunningHandoff('codex-child')
    await expect(callAsync('handoff_message', { handoffId: id, text: 'status?' })).rejects.toThrow(
      /espelho da tela/,
    )
    expect(injectIntoChild).not.toHaveBeenCalled()
  })

  it('tira caracteres de controle: um ESC[201~ não fecha o paste antes da hora', async () => {
    const id = seedRunningHandoff()
    await callAsync('handoff_message', { handoffId: id, text: 'oi\x1b[201~\x1b[Bfim\nlinha' })
    expect(injectIntoChild).toHaveBeenCalledWith('s-child', 'oi[201~[Bfim\nlinha')
  })

  it('404 quando o handoff não existe', () => {
    expect(() => call('handoff_message', { handoffId: 'nope', text: 'x' })).toThrow(
      /não encontrado/,
    )
  })

  it('rejeita quando o status não é in-flight (ex.: done)', () => {
    const id = seedRunningHandoff()
    handoffStore.report(id, 'concluído')
    expect(() => call('handoff_message', { handoffId: id, text: 'x' })).toThrow(
      /não está em andamento/,
    )
    expect(injectIntoChild).not.toHaveBeenCalled()
  })

  it('rejeita quando a PTY da filha está morta', () => {
    const id = seedRunningHandoff()
    isRunning.mockReturnValue(false)
    expect(() => call('handoff_message', { handoffId: id, text: 'x' })).toThrow(
      /não está mais viva/,
    )
    expect(injectIntoChild).not.toHaveBeenCalled()
  })
})

describe('handoff_progress durante needs_input (regressão: filha apagava a própria pergunta)', () => {
  it('preserva pergunta + status, grava o passo e devolve o bloqueio ainda aberto', () => {
    const id = seedRunningHandoff()
    call('handoff_ask', { handoffId: id, question: 'posso trocar o schema?' })
    const res = call<{
      status: string
      currentStep: string | null
      pendingQuestion?: string | null
      note?: string
    }>('handoff_progress', { handoffId: id, step: 'seguindo pelo caminho A' })

    expect(res.status).toBe('needs_input')
    expect(res.currentStep).toBe('seguindo pelo caminho A')
    expect(res.pendingQuestion).toBe('posso trocar o schema?')
    expect(res.note).toMatch(/ABERTA/)

    // E a mãe, ao polar, continua vendo a pergunta.
    const polled = call<{ status: string; pendingQuestion: string | null }>('handoff_result', {
      handoffId: id,
    })
    expect(polled.status).toBe('needs_input')
    expect(polled.pendingQuestion).toBe('posso trocar o schema?')
  })

  it('handoff_message (resposta da mãe) é o que encerra: needs_input → running', async () => {
    const id = seedRunningHandoff()
    call('handoff_ask', { handoffId: id, question: 'posso trocar o schema?' })
    call('handoff_progress', { handoffId: id, step: 'ainda esperando' })
    await callAsync('handoff_message', { handoffId: id, text: 'pode sim' })

    const polled = call<{
      status: string
      pendingQuestion: string | null
      currentStep: string
    }>('handoff_result', { handoffId: id })
    expect(polled.status).toBe('running')
    expect(polled.pendingQuestion).toBeNull()
    expect(polled.currentStep).toBe('ainda esperando')
  })
})

describe('handoff_report duplicado', () => {
  it('avisa e preserva o resultado original em vez de sumir em silêncio', () => {
    const id = seedRunningHandoff()
    const first = call<{ status: string; duplicate?: boolean }>('handoff_report', {
      handoffId: id,
      summary: 'resultado original',
    })
    expect(first.duplicate).toBeUndefined()

    const second = call<{
      status: string
      duplicate?: boolean
      warning?: string
    }>('handoff_report', { handoffId: id, summary: 'resultado repetido' })
    expect(second.status).toBe('done')
    expect(second.duplicate).toBe(true)
    expect(second.warning).toMatch(/já havia sido reportado/)
    expect(handoffStore.get(id)?.summary).toBe('resultado original')
  })
})

describe('handoff_result (enriquecido com atividade ao vivo)', () => {
  it('inclui liveStatus/lastText/tokens e pendingQuestion', () => {
    const id = seedRunningHandoff()
    handoffStore.ask(id, 'minha pergunta')
    const res = call<{
      status: string
      pendingQuestion: string | null
      liveStatus: string | null
      lastText: string | null
      tokens: { output: number; context: number } | null
    }>('handoff_result', { handoffId: id })
    expect(res.status).toBe('needs_input')
    expect(res.pendingQuestion).toBe('minha pergunta')
    expect(res.liveStatus).toBe('working')
    expect(res.lastText).toBe('editando arquivo')
    expect(res.tokens).toEqual({ output: 10, context: 200 })
  })
})

// Regressão: depois da passagem de bastão a ANTECESSORA continua viva com o
// handoffId antigo no contexto dela. Quando ela fecha o próprio turno chamando
// handoff_report, fecharia o card de um trabalho que agora é da SUCESSORA.
describe('posse do handoff (antecessora do bastão não fala pelo handoff)', () => {
  it('handoff_report da antecessora é RECUSADO e o handoff continua vivo', () => {
    const id = seedRunningHandoff('s-sucessora')
    expect(() =>
      callAs('s-antecessora', 'handoff_report', {
        handoffId: id,
        summary: 'terminei',
      }),
    ).toThrow(/já não é seu/)
    expect(handoffStore.get(id)!.status).toBe('running')
    expect(handoffStore.get(id)!.summary).toBeNull()
  })

  it('a recusa explica o que houve (passou o bastão) e para onde falar', () => {
    const id = seedRunningHandoff('s-sucessora')
    expect(() =>
      callAs('s-antecessora', 'handoff_report', {
        handoffId: id,
        summary: 'terminei',
      }),
    ).toThrow(/bastão[\s\S]*SendMessage/)
  })

  it('handoff_progress e handoff_ask da antecessora também são recusados', () => {
    const id = seedRunningHandoff('s-sucessora')
    expect(() => callAs('s-antecessora', 'handoff_progress', { handoffId: id, step: 'x' })).toThrow(
      /já não é seu/,
    )
    expect(() => callAs('s-antecessora', 'handoff_ask', { handoffId: id, question: 'q' })).toThrow(
      /já não é seu/,
    )
    const h = handoffStore.get(id)!
    expect(h.status).toBe('running')
    expect(h.currentStep).toBeNull()
    expect(h.pendingQuestion).toBeNull()
  })

  it('a filha ATUAL reporta normalmente', () => {
    const id = seedRunningHandoff('s-sucessora')
    const res = callAs<{ status: string }>('s-sucessora', 'handoff_report', {
      handoffId: id,
      summary: 'feito',
    })
    expect(res.status).toBe('done')
  })

  // Retrocompat: sem uma das duas identidades não há como distinguir "sessão
  // legada" de "passou o bastão" — e recusar aí quebraria handoffs em curso.
  it('chamador SEM carimbo (config MCP global/legada) segue funcionando', () => {
    const id = seedRunningHandoff('s-sucessora')
    const res = callAs<{ status: string }>(null, 'handoff_report', {
      handoffId: id,
      summary: 'feito por sessão legada',
    })
    expect(res.status).toBe('done')
  })

  it('handoff SEM filha atrelada aceita de qualquer sessão carimbada', () => {
    const h = handoffStore.create({
      targetRepoId: 'r1',
      task: 't',
      composedPrompt: 'p',
    })
    handoffStore.approve(h.id, {})
    const res = callAs<{ status: string }>('s-qualquer', 'handoff_report', {
      handoffId: h.id,
      summary: 'feito',
    })
    expect(res.status).toBe('done')
  })
})

// Bolinha no mapa: cada handler que leva algo de uma sessão a outra avisa o
// barramento com from/to certos. Chamando os handlers reais, com o banco real.
describe('pulsos de link entre sessões (session-link-pulse)', () => {
  const pulses: SessionLinkPulse[] = []
  let clock = Date.now()
  let off: () => void = () => {}
  beforeEach(() => {
    pulses.length = 0
    // O barramento limita pulsos por par por segundo; cada caso começa numa janela nova.
    vi.useFakeTimers({ toFake: ['Date'] })
    clock += 60_000
    vi.setSystemTime(clock)
    off()
    off = onSessionLinkPulse((p) => pulses.push(p))
  })
  afterEach(() => vi.useRealTimers())
  afterAll(() => off())

  // Mãe e filha com nome (o rótulo do pulso sai de sessions.title).
  function seedFamily(): string {
    const id = seedRunningHandoff('s-filha')
    const db = getDb()
    db.prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, title, status, started_at) VALUES ('s-mae', 'r1', 'cc-s-mae', 'mae', 'running', ?)`,
    ).run(Date.now())
    db.prepare(`UPDATE sessions SET title = 'otavio' WHERE id = 's-filha'`).run()
    db.prepare(`UPDATE handoffs SET mother_session_id = 's-mae' WHERE id = ?`).run(id)
    return id
  }
  const shape = (p: SessionLinkPulse) => [p.fromSessionId, p.toSessionId, p.kind]

  it('session_handoff: mãe → filha recém-criada, tipo task', () => {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)`,
      )
      .run(Date.now(), Date.now())
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO repos (id, project_id, label, path, position, created_at) VALUES ('r1','p1','R1','/tmp/r1',0,?)`,
      )
      .run(Date.now())
    setSpawnHandoffChild(() => {
      getDb()
        .prepare(
          `INSERT INTO sessions (id, repo_id, title, status, started_at) VALUES ('s-nova', 'r1', 'nova', 'running', ?)`,
        )
        .run(Date.now())
      return { id: 's-nova' } as never
    })
    callAs('s-mae', 'session_handoff', { targetRepo: 'R1', task: 'investigar' })
    expect(pulses.map(shape)).toEqual([['s-mae', 's-nova', 'task']])
  })

  it('handoff_message: mãe → filha (message) e, com pergunta aberta, answer', async () => {
    const id = seedFamily()
    await callAsync('handoff_message', { handoffId: id, text: 'status?' })
    handoffStore.ask(id, 'qual lib?')
    await callAsync('handoff_message', { handoffId: id, text: 'zod' })
    expect(pulses.map(shape)).toEqual([
      ['s-mae', 's-filha', 'message'],
      ['s-mae', 's-filha', 'answer'],
    ])
    expect(pulses[0].label).toBe('mae → otavio: mensagem')
  })

  it('mensagem recusada pelo guard não pulsa (nada chegou)', async () => {
    const id = seedFamily()
    showScreen('s-filha', PERMISSION_SCREEN)
    await expect(callAsync('handoff_message', { handoffId: id, text: 'x' })).rejects.toThrow()
    expect(pulses).toEqual([])
  })

  it('handoff_ask / progress / report: filha → mãe', () => {
    const id = seedFamily()
    callAs('s-filha', 'handoff_ask', { handoffId: id, question: 'qual lib?' })
    callAs('s-filha', 'handoff_progress', { handoffId: id, step: 'lendo o código' })
    // Mesmo passo de novo não é notícia.
    callAs('s-filha', 'handoff_progress', { handoffId: id, step: 'lendo o código' })
    callAs('s-filha', 'handoff_report', { handoffId: id, summary: 'feito' })
    expect(pulses.map(shape)).toEqual([
      ['s-filha', 's-mae', 'question'],
      ['s-filha', 's-mae', 'progress'],
      ['s-filha', 's-mae', 'report'],
    ])
  })
})
