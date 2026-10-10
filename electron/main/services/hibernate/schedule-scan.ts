import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'

// Item f da hibernação: sessão que algum dia agendou trabalho (CronCreate,
// ScheduleWakeup, RemoteTrigger ou /loop) nunca hiberna — um /exit mataria o
// agendamento sem aviso. Não tenta casar cancelamento: qualquer ocorrência basta.
//
// Formato (o mesmo que chat-transcript.ts lê): tool_use dentro de
// message.content[] do assistant; slash command como
// "<command-name>/loop</command-name>" no content do user.

const SCHEDULING_TOOLS = new Set(['CronCreate', 'ScheduleWakeup', 'RemoteTrigger'])
const LOOP_COMMAND = '<command-name>/loop</command-name>'
// Filtro barato antes do JSON.parse: só linhas que citam algum marcador.
const PREFILTER = /CronCreate|ScheduleWakeup|RemoteTrigger|<command-name>\/loop<\/command-name>/

interface Line {
  type?: string
  message?: { role?: string; content?: unknown }
}

function contentStrings(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content
    .map((c) => (c && typeof c === 'object' ? (c as { text?: unknown }).text : null))
    .filter((t): t is string => typeof t === 'string')
}

// true = a linha prova agendamento. Linha que cita o marcador mas não desserializa
// conta como agendamento: na dúvida, não hiberna.
export function lineSchedules(raw: string): boolean {
  if (!PREFILTER.test(raw)) return false
  let line: Line
  try {
    line = JSON.parse(raw) as Line
  } catch {
    return true
  }
  const content = line.message?.content
  if (Array.isArray(content)) {
    for (const item of content) {
      const c = item as { type?: unknown; name?: unknown }
      if (c?.type === 'tool_use' && typeof c.name === 'string' && SCHEDULING_TOOLS.has(c.name)) {
        return true
      }
    }
  }
  if (line.type === 'user' || line.message?.role === 'user') {
    return contentStrings(content).some((t) => t.includes(LOOP_COMMAND))
  }
  return false
}

interface CacheEntry {
  size: number
  mtimeMs: number
  scheduled: boolean
}

export class ScheduleScanner {
  private cache = new Map<string, CacheEntry>()

  // null = transcript ilegível (sumiu, sem permissão): quem chama recusa.
  async usedScheduling(path: string): Promise<boolean | null> {
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
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.scheduled
    const scheduled = await this.scan(path)
    if (scheduled === null) return null
    this.cache.set(path, { size, mtimeMs, scheduled })
    return scheduled
  }

  private async scan(path: string): Promise<boolean | null> {
    const stream = createReadStream(path, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (lineSchedules(line)) return true
      }
      return false
    } catch {
      return null
    } finally {
      lines.close()
      stream.destroy()
    }
  }
}
