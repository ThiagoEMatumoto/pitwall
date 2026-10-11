import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundTracker, ScheduleScanner, lineSchedules } from './schedule-scan'

// Linhas no formato que o claude grava (o mesmo de chat-transcript.test.ts).
const userText = (content: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content } })
const toolUse = (name: string) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_1', name, input: {} }],
    },
  })
const assistantText = (text: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })

describe('lineSchedules', () => {
  it.each(['CronCreate', 'ScheduleWakeup', 'RemoteTrigger'])('tool_use %s agenda', (name) => {
    expect(lineSchedules(toolUse(name))).toBe(true)
  })

  it('/loop digitado agenda', () => {
    expect(
      lineSchedules(
        userText('<command-name>/loop</command-name>\n<command-args>5m /check</command-args>'),
      ),
    ).toBe(true)
  })

  it('só falar do nome da tool não agenda', () => {
    expect(lineSchedules(assistantText('Posso usar ScheduleWakeup ou CronCreate aqui.'))).toBe(
      false,
    )
    expect(lineSchedules(userText('o que faz o ScheduleWakeup?'))).toBe(false)
    expect(lineSchedules(toolUse('Bash'))).toBe(false)
  })

  it('outro slash command não agenda', () => {
    expect(lineSchedules(userText('<command-name>/model</command-name>'))).toBe(false)
  })

  it('linha com marcador que não desserializa conta como agendamento', () => {
    expect(lineSchedules('{"type":"assistant","message":{"content":[{"name":"CronCreate"')).toBe(
      true,
    )
  })
})

// Trabalho em background. Linhas com as MESMAS chaves e textos que o claude
// 2.1.29x grava, copiadas de ~/.claude/projects/*.jsonl reais (só a estrutura;
// ids, comandos e resumos trocados).
const assistantToolUse = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    isSidechain: false,
    message: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }],
      stop_reason: 'tool_use',
    },
    type: 'assistant',
    timestamp: '2026-09-05T04:10:42.211Z',
    sessionId: 's-1',
  })
const userToolResult = (
  toolUseId: string,
  content: string,
  toolUseResult: unknown,
  isError?: boolean,
) =>
  JSON.stringify({
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: toolUseId,
          type: 'tool_result',
          content,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
    timestamp: '2026-09-05T04:10:44.805Z',
    toolUseResult,
    sessionId: 's-1',
  })
// A notificação chega como queue-operation e depois como mensagem do user.
const queueNotification = (body: string) =>
  JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: '2026-09-05T04:10:44.989Z',
    sessionId: 's-1',
    content: `<task-notification>\n${body}\n</task-notification>`,
  })
const userNotification = (body: string) =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: `<task-notification>\n${body}\n</task-notification>` },
    origin: { kind: 'task-notification' },
    promptSource: 'system',
    sessionId: 's-1',
  })

const MONITOR_USE = assistantToolUse('toolu_mon', 'Monitor', {
  description: 'mudanças de status',
  persistent: true,
  timeout_ms: 3600000,
  command: 'while true; do date; sleep 60; done',
})
const MONITOR_STARTED = userToolResult(
  'toolu_mon',
  'Monitor started (task bmon1, persistent — runs until TaskStop or session end).',
  { taskId: 'bmon1', timeoutMs: 0, persistent: true },
)
const MONITOR_EVENT = queueNotification(
  '<task-id>bmon1</task-id>\n<summary>Monitor event: "mudanças de status"</summary>\n<event>{"status":"running"}</event>',
)

function track(lines: string[]): boolean {
  const tracker = new BackgroundTracker()
  for (const line of lines) tracker.feed(line)
  return tracker.hasOpen()
}

describe('BackgroundTracker', () => {
  it('Monitor iniciado e só com eventos fica aberto', () => {
    expect(track([MONITOR_USE, MONITOR_STARTED, MONITOR_EVENT])).toBe(true)
  })

  it('Monitor fecha com a notificação terminal (stream ended, pelo tool-use-id)', () => {
    const ended = userNotification(
      '<task-id>bmon1</task-id>\n<tool-use-id>toolu_mon</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n<summary>Monitor "mudanças de status" stream ended</summary>',
    )
    expect(track([MONITOR_USE, MONITOR_STARTED, MONITOR_EVENT, ended])).toBe(false)
  })

  it('Monitor fecha com o resumo órfão "stopped" que lista vários task-id', () => {
    const orphan = queueNotification(
      '<task-id>bmon1</task-id>\n<task-id>bother</task-id>\n<status>stopped</status>\n<summary>2 background shell command task(s) from the previous session have no completion record.</summary>',
    )
    expect(track([MONITOR_USE, MONITOR_STARTED, orphan])).toBe(false)
  })

  it('Monitor fecha com TaskStop bem-sucedido; TaskStop com erro não fecha', () => {
    const stop = assistantToolUse('toolu_stop', 'TaskStop', { task_id: 'bmon1' })
    const stopped = userToolResult(
      'toolu_stop',
      '{"message":"Successfully stopped task: bmon1 (while true; do date; sleep 60; done)","task_id":"bmon1","task_type":"local_bash"}',
      { message: 'Successfully stopped task: bmon1', task_id: 'bmon1', task_type: 'local_bash' },
    )
    expect(track([MONITOR_USE, MONITOR_STARTED, stop, stopped])).toBe(false)
    const failed = userToolResult('toolu_stop', 'No task found with ID: bmon1', null, true)
    expect(track([MONITOR_USE, MONITOR_STARTED, stop, failed])).toBe(true)
  })

  it('notificação terminal ANTES do Monitor não fecha o Monitor', () => {
    const early = userNotification(
      '<task-id>bmon1</task-id>\n<tool-use-id>toolu_mon</tool-use-id>\n<status>completed</status>',
    )
    expect(track([early, MONITOR_USE, MONITOR_STARTED])).toBe(true)
  })

  it('Monitor cuja chamada falhou não deixa nada aberto', () => {
    const failed = userToolResult('toolu_mon', 'Error: invalid command', null, true)
    expect(track([MONITOR_USE, failed])).toBe(false)
  })

  it('task MCP em background fica aberta até a notificação com o mesmo task-id', () => {
    const call = assistantToolUse('toolu_mcp', 'mcp__srv__long_job', { q: 'x' })
    const started = userToolResult(
      'toolu_mcp',
      'MCP tool "srv long_job" started server-side task t-42, running in the background as task bmcp7. To stop it, use TaskStop with task_id "bmcp7"; the result arrives as a task notification.',
      [
        {
          type: 'text',
          text: 'MCP tool "srv long_job" started server-side task t-42, running in the background as task bmcp7.',
        },
      ],
    )
    expect(track([call, started])).toBe(true)
    const done = userNotification(
      '<task-id>bmcp7</task-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n<summary>MCP task finished</summary>',
    )
    expect(track([call, started, done])).toBe(false)
  })

  it('task MCP cancelada na largada ("no result will follow") não fica aberta', () => {
    const call = assistantToolUse('toolu_mcp', 'mcp__srv__long_job', {})
    const cancelled = userToolResult(
      'toolu_mcp',
      'MCP tool "srv long_job" started server-side task t-42, but background task bmcp7 was stopped by the user before the task handle arrived. A cancel was sent to the server; no result will follow.',
      null,
    )
    expect(track([call, cancelled])).toBe(false)
  })

  it('ferramenta MCP comum que devolve taskId no corpo NÃO conta como task', () => {
    // Forma real do mcp__pitwall__task_create: o id da task do Pitwall no JSON.
    const call = assistantToolUse('toolu_tc', 'mcp__pitwall__task_create', { title: 'x' })
    const result = userToolResult('toolu_tc', '{"taskId":"5f1c","title":"x","status":"todo"}', [
      { type: 'text', text: '{"taskId":"5f1c","title":"x","status":"todo"}' },
    ])
    expect(track([call, result])).toBe(false)
  })

  it('TeamCreate fica aberto até TeamDelete; teammate fica aberto até notificação', () => {
    const create = assistantToolUse('toolu_team', 'TeamCreate', { team_name: 'squad' })
    expect(track([create])).toBe(true)
    expect(track([create, assistantToolUse('toolu_del', 'TeamDelete', {})])).toBe(false)
    const mate = assistantToolUse('toolu_mate', 'Agent', {
      name: 'ana',
      team_name: 'squad',
      prompt: 'x',
    })
    expect(track([mate])).toBe(true)
    const done = userNotification(
      '<task-id>amate</task-id>\n<tool-use-id>toolu_mate</tool-use-id>\n<status>completed</status>',
    )
    expect(track([mate, done])).toBe(false)
  })

  it('linha com marcador que não desserializa conta como aberta', () => {
    expect(track(['{"type":"assistant","message":{"content":[{"name":"Monitor"'])).toBe(true)
  })

  it('subagente comum (Agent sem team_name) não é rastreado aqui', () => {
    expect(track([assistantToolUse('toolu_ag', 'Agent', { prompt: 'x' })])).toBe(false)
  })
})

describe('ScheduleScanner', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'schedule-scan-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('Monitor aberto no transcript → background-task; agendamento tem precedência', async () => {
    const path = join(dir, 'm.jsonl')
    writeFileSync(path, `${MONITOR_USE}\n${MONITOR_STARTED}\n${MONITOR_EVENT}\n`)
    const scanner = new ScheduleScanner()
    expect(await scanner.scan(path)).toBe('background-task')
    appendFileSync(path, `${toolUse('CronCreate')}\n`)
    expect(await scanner.scan(path)).toBe('scheduled')
  })

  it('acha o agendamento no meio de um transcript longo e cacheia por (size, mtime)', async () => {
    const path = join(dir, 's.jsonl')
    const filler = Array.from({ length: 2_000 }, (_, i) => assistantText(`linha ${i}`)).join('\n')
    writeFileSync(path, `${filler}\n${userText('oi')}\n`)
    const scanner = new ScheduleScanner()
    expect(await scanner.scan(path)).toBe('clear')

    appendFileSync(path, `${toolUse('ScheduleWakeup')}\n${filler}\n`)
    expect(await scanner.scan(path)).toBe('scheduled')
  })

  it('cache: mesmo (size, mtime) não relê', async () => {
    const path = join(dir, 's.jsonl')
    writeFileSync(path, `${userText('oi')}\n`)
    const scanner = new ScheduleScanner()
    expect(await scanner.scan(path)).toBe('clear')
    // Mesmo tamanho, mesmo mtime, conteúdo diferente: prova que veio do cache.
    const same = `${userText('xy')}\n`
    writeFileSync(path, same)
    const t = new Date(Date.now() - 60_000)
    utimesSync(path, t, t)
    const fresh = await scanner.scan(path)
    expect(fresh).toBe('clear')
    writeFileSync(path, `${toolUse('CronCreate')}\n`)
    utimesSync(path, t, t)
    // tamanho mudou → relê.
    expect(await scanner.scan(path)).toBe('scheduled')
  })

  it('transcript ausente devolve null (quem chama recusa)', async () => {
    expect(await new ScheduleScanner().scan(join(dir, 'nope.jsonl'))).toBeNull()
  })
})
