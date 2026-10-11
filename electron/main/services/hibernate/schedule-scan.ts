import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'

// Itens f da hibernação, lidos do transcript da sessão.
//
// 1. Agendamento: sessão que algum dia agendou trabalho (CronCreate,
//    ScheduleWakeup, RemoteTrigger ou /loop) nunca hiberna — um /exit mataria o
//    agendamento sem aviso. Não tenta casar cancelamento: qualquer ocorrência basta.
// 2. Trabalho em background que o status 'idle' do claude não conta (roda
//    in-process ou dentro de um servidor MCP, então o proc-tree também não vê):
//    Monitor (qualquer fonte), teammates e tasks de ferramenta MCP. Fica aberto
//    até um <task-notification> terminal posterior com o mesmo id.
//
// Formato real (claude 2.1.29x): tool_use em message.content[] do assistant; o
// tool_result do user traz toolUseResult.taskId (Monitor: {taskId, timeoutMs,
// persistent}). A notificação aparece como queue-operation, attachment
// queued_command ou mensagem do user, sempre com <task-id> e às vezes
// <tool-use-id>; só a terminal tem <status>. Eventos do Monitor não têm status.

export type TranscriptVerdict = 'clear' | 'scheduled' | 'background-task'

const SCHEDULING_TOOLS = new Set(['CronCreate', 'ScheduleWakeup', 'RemoteTrigger'])
const LOOP_COMMAND = '<command-name>/loop</command-name>'
const SCHEDULING_RE = /CronCreate|ScheduleWakeup|RemoteTrigger|<command-name>\/loop<\/command-name>/
// Filtro barato antes do JSON.parse: só linhas que podem abrir ou fechar trabalho.
const BACKGROUND_RE =
  /"Monitor"|"TaskStop"|"Team(Create|Delete)"|"team_name"|"mcp__|<task-notification>|"taskId"/
const TERMINAL_STATUS = new Set(['completed', 'failed', 'killed', 'stopped'])
// Texto que o claude (2.1.296) devolve quando uma ferramenta MCP vira task em
// background: `MCP tool "x" started server-side task T, running in the background
// as task <id>`. Sem o "running…", só os desfechos que avisam "no result will
// follow" (cancelada na largada) não ficam abertos.
const MCP_TASK_STARTED = 'started server-side task'
const MCP_TASK_BG_RE = /running in the background as task (\w+)/
const MCP_TASK_CANCELLED = 'no result will follow'

interface ContentItem {
  type?: unknown
  name?: unknown
  id?: unknown
  tool_use_id?: unknown
  is_error?: unknown
  input?: unknown
  text?: unknown
}

interface Line {
  type?: string
  message?: { role?: string; content?: unknown }
  toolUseResult?: unknown
}

function contentStrings(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content
    .map((c) => (c && typeof c === 'object' ? (c as ContentItem).text : null))
    .filter((t): t is string => typeof t === 'string')
}

function contentItems(line: Line): ContentItem[] {
  const content = line.message?.content
  return Array.isArray(content)
    ? (content as ContentItem[]).filter((c) => c && typeof c === 'object')
    : []
}

// true = a linha prova agendamento. Linha que cita o marcador mas não desserializa
// conta como agendamento: na dúvida, não hiberna.
export function lineSchedules(raw: string): boolean {
  if (!SCHEDULING_RE.test(raw)) return false
  let line: Line
  try {
    line = JSON.parse(raw) as Line
  } catch {
    return true
  }
  for (const c of contentItems(line)) {
    if (c.type === 'tool_use' && typeof c.name === 'string' && SCHEDULING_TOOLS.has(c.name)) {
      return true
    }
  }
  if (line.type === 'user' || line.message?.role === 'user') {
    return contentStrings(line.message?.content).some((t) => t.includes(LOOP_COMMAND))
  }
  return false
}

// Trabalho em background aberto no transcript, alimentado linha a linha em ordem.
export class BackgroundTracker {
  // id (tool_use id ou task id) → trabalho; um trabalho tem os dois ids.
  private open = new Map<string, Set<string>>()
  private mcpCalls = new Set<string>()
  // tool_use id do TaskStop → task que ele para.
  private stops = new Map<string, string>()
  private teams = 0
  private unreadable = false

  feed(raw: string): void {
    const awaitingResult =
      (this.mcpCalls.size > 0 || this.stops.size > 0 || this.open.size > 0) &&
      raw.includes('"tool_result"')
    if (!BACKGROUND_RE.test(raw) && !awaitingResult) return
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      this.unreadable = true // marcador que não desserializa: na dúvida, aberto.
      return
    }
    for (const c of contentItems(line)) {
      if (c.type === 'tool_use') this.onToolUse(c)
      else if (c.type === 'tool_result') this.onToolResult(c, line, raw)
    }
    for (const block of raw.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
      this.onNotification(block)
    }
  }

  hasOpen(): boolean {
    return this.unreadable || this.teams > 0 || this.open.size > 0
  }

  private start(...ids: string[]): void {
    const work = new Set(ids)
    for (const id of ids) this.open.set(id, work)
  }

  private finish(id: string): void {
    const work = this.open.get(id)
    if (!work) return
    for (const other of work) this.open.delete(other)
  }

  private onToolUse(c: ContentItem): void {
    if (typeof c.id !== 'string' || typeof c.name !== 'string') return
    const input = (c.input && typeof c.input === 'object' ? c.input : {}) as Record<string, unknown>
    if (c.name === 'Monitor') this.start(c.id)
    else if (c.name === 'TeamCreate') this.teams++
    else if (c.name === 'TeamDelete') this.teams = 0
    else if (typeof input.team_name === 'string')
      this.start(c.id) // spawn de teammate.
    else if (c.name === 'TaskStop' && typeof input.task_id === 'string') {
      this.stops.set(c.id, input.task_id)
    } else if (c.name.startsWith('mcp__')) this.mcpCalls.add(c.id)
  }

  private onToolResult(c: ContentItem, line: Line, raw: string): void {
    if (typeof c.tool_use_id !== 'string') return
    const id = c.tool_use_id
    // TaskStop que deu certo encerra a task sem gerar <task-notification>.
    const stopped = this.stops.get(id)
    if (stopped !== undefined) {
      this.stops.delete(id)
      if (c.is_error !== true) this.finish(stopped)
    }
    if (this.mcpCalls.delete(id) && raw.includes(MCP_TASK_STARTED)) {
      const bg = MCP_TASK_BG_RE.exec(raw)
      if (bg) this.start(id, bg[1]!)
      else if (!raw.includes(MCP_TASK_CANCELLED)) this.start(id)
    }
    const work = this.open.get(id)
    if (!work) return
    // Ferramenta que falhou não deixou nada rodando.
    if (c.is_error === true) return this.finish(id)
    const result = line.toolUseResult as { taskId?: unknown } | undefined
    if (typeof result?.taskId === 'string') {
      work.add(result.taskId)
      this.open.set(result.taskId, work)
    }
  }

  private onNotification(block: string): void {
    const status = /<status>(\w+)<\/status>/.exec(block)?.[1]
    if (!status || !TERMINAL_STATUS.has(status)) return // evento, não fim.
    for (const m of block.matchAll(/<(task-id|tool-use-id)>([^<]+)<\/\1>/g)) this.finish(m[2]!)
  }
}

interface CacheEntry {
  size: number
  mtimeMs: number
  verdict: TranscriptVerdict
}

export class ScheduleScanner {
  private cache = new Map<string, CacheEntry>()

  // null = transcript ilegível (sumiu, sem permissão): quem chama recusa.
  async scan(path: string): Promise<TranscriptVerdict | null> {
    let size: number
    let mtimeMs: number
    try {
      const st = await stat(path)
      size = st.size
      mtimeMs = st.mtimeMs
    } catch {
      return null
    }
    const hit = this.cache.get(path)
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.verdict
    const verdict = await this.read(path)
    if (verdict === null) return null
    this.cache.set(path, { size, mtimeMs, verdict })
    return verdict
  }

  private async read(path: string): Promise<TranscriptVerdict | null> {
    const stream = createReadStream(path, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    const tracker = new BackgroundTracker()
    try {
      for await (const line of lines) {
        if (lineSchedules(line)) return 'scheduled'
        tracker.feed(line)
      }
      return tracker.hasOpen() ? 'background-task' : 'clear'
    } catch {
      return null
    } finally {
      lines.close()
      stream.destroy()
    }
  }
}
