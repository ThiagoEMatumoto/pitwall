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

// Raciocínio intercalado entre chamadas: não quebra o grupo, aparece nele aberto.
export interface ThinkingEntry {
  kind: 'thinking'
  index: number
  text: string
}

export type GroupEntry = ToolEntry | ThinkingEntry

export type ChatRow =
  { type: 'message'; index: number } | { type: 'tools'; index: number; entries: GroupEntry[] }

// Linhas da conversa: cada tool_use leva o seu tool_result junto e uma sequência
// de chamadas (com raciocínio entre elas) vira um grupo só. `skip` são índices
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
  let group: GroupEntry[] = []
  // Só o raciocínio ENTRE chamadas entra no grupo: o de antes da primeira e o
  // de depois da última (que costuma explicar a resposta) continua à vista.
  const flush = () => {
    const first = group.findIndex((e) => e.kind === 'tool')
    if (first < 0) {
      for (const e of group) rows.push({ type: 'message', index: e.index })
    } else {
      let last = group.length - 1
      while (group[last].kind !== 'tool') last--
      for (const e of group.slice(0, first)) rows.push({ type: 'message', index: e.index })
      rows.push({ type: 'tools', index: group[first].index, entries: group.slice(first, last + 1) })
      for (const e of group.slice(last + 1)) rows.push({ type: 'message', index: e.index })
    }
    group = []
  }
  messages.forEach((m, i) => {
    if (skip.has(i) || attached.has(i)) return
    const tool = entries.get(i)
    if (tool) {
      group.push(tool)
    } else if (m.kind === 'thinking' && !own.has(i)) {
      group.push({ kind: 'thinking', index: i, text: m.text })
    } else {
      flush()
      rows.push({ type: 'message', index: i })
    }
  })
  flush()
  return rows
}

export function toolEntries(entries: GroupEntry[]): ToolEntry[] {
  return entries.filter((e): e is ToolEntry => e.kind === 'tool')
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
