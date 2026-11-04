import type { ChatMessage } from '../../../../shared/types/ipc'

type ToolUseMsg = Extract<ChatMessage, { kind: 'tool_use' }>
type ToolResultMsg = Extract<ChatMessage, { kind: 'tool_result' }>

// Uma chamada de ferramenta já pareada com o seu resultado (por tool_use_id).
export interface ToolEntry {
  kind: 'tool'
  index: number
  use: ToolUseMsg
  result?: ToolResultMsg
}

export type ChatRow =
  { type: 'message'; index: number } | { type: 'tools'; index: number; entries: ToolEntry[] }

// Linhas da conversa: cada tool_use leva o seu tool_result junto e uma sequência
// de chamadas seguidas vira um grupo só. O raciocínio quebra o grupo: o TUI o
// mostra inline, e dentro de um grupo colapsado ele sumiria. `skip` são índices
// que não renderizam (fundidos em cards de artefato); `own` são índices com card
// próprio (artefato/consulta), que nunca entram num grupo.
export function buildChatRows(
  messages: ChatMessage[],
  skip: ReadonlySet<number> = new Set(),
  own: ReadonlySet<number> = new Set(),
): ChatRow[] {
  const byId = new Map<string, ToolEntry>()
  const entries = new Map<number, ToolEntry>()
  messages.forEach((m, i) => {
    if (m.kind !== 'tool_use' || skip.has(i) || own.has(i)) return
    const entry: ToolEntry = { kind: 'tool', index: i, use: m }
    entries.set(i, entry)
    if (m.id) byId.set(m.id, entry)
  })
  const attached = new Set<number>()
  messages.forEach((m, i) => {
    if (m.kind !== 'tool_result' || skip.has(i) || own.has(i)) return
    const entry = m.forId ? byId.get(m.forId) : undefined
    if (entry && !entry.result) {
      entry.result = m
      attached.add(i)
    }
  })

  const rows: ChatRow[] = []
  let group: ToolEntry[] = []
  const flush = () => {
    if (group.length) rows.push({ type: 'tools', index: group[0].index, entries: group })
    group = []
  }
  messages.forEach((_, i) => {
    if (skip.has(i) || attached.has(i)) return
    const tool = entries.get(i)
    if (tool) {
      group.push(tool)
    } else {
      flush()
      rows.push({ type: 'message', index: i })
    }
  })
  flush()
  return rows
}

// Ritmo vertical: respiro grande quando o humano abre um turno novo, pequeno
// entre as partes de uma mesma resposta.
export type RowRhythm = 'turn' | 'assistant' | 'tools' | 'aside'

export function rowRhythm(row: ChatRow, messages: ChatMessage[]): RowRhythm {
  if (row.type === 'tools') return 'tools'
  const m = messages[row.index]
  if (m.kind === 'user' || m.kind === 'command') return 'turn'
  if (m.kind === 'assistant') return 'assistant'
  return 'aside'
}

export function rowSpacing(prev: RowRhythm | null, cur: RowRhythm): string {
  if (prev == null) return ''
  if (cur === 'turn') return 'mt-8'
  if (prev === 'turn') return 'mt-5'
  if (cur === 'assistant' || prev === 'assistant') return 'mt-3'
  return 'mt-1.5'
}
