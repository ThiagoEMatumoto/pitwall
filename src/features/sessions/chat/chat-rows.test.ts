import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../../shared/types/ipc'
import { parseChatMessages } from '../../../../electron/main/services/chat-transcript'
import { buildChatRows, rowRhythm, rowSpacing, toolEntries } from './chat-rows'

// Linhas no formato que a CLI grava no JSONL: o shape vem do parser real.
function line(obj: unknown): string {
  return JSON.stringify(obj)
}
function assistantTools(msgId: string, tools: Array<{ id: string; name: string; input: unknown }>) {
  return line({
    type: 'assistant',
    message: {
      id: msgId,
      role: 'assistant',
      content: tools.map((t) => ({ type: 'tool_use', ...t })),
    },
  })
}
function results(items: Array<{ id: string; text: string; error?: boolean }>) {
  return line({
    type: 'user',
    message: {
      role: 'user',
      content: items.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.text,
        is_error: r.error === true,
      })),
    },
  })
}

describe('buildChatRows (transcript real do parser)', () => {
  const jsonl = [
    line({ type: 'user', message: { role: 'user', content: 'arruma o teste' } }),
    assistantTools('m1', [
      { id: 't1', name: 'Read', input: { file_path: '/r/a.ts' } },
      { id: 't2', name: 'Read', input: { file_path: '/r/b.ts' } },
    ]),
    results([
      { id: 't1', text: 'conteúdo a' },
      { id: 't2', text: 'conteúdo b' },
    ]),
    assistantTools('m2', [{ id: 't3', name: 'Bash', input: { command: 'npm test' } }]),
    results([{ id: 't3', text: 'falhou', error: true }]),
    line({
      type: 'assistant',
      message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'Pronto.' }] },
    }),
  ].join('\n')
  const messages = parseChatMessages(jsonl)

  it('pareia cada resultado com a sua chamada e agrupa a sequência', () => {
    const rows = buildChatRows(messages)
    expect(rows.map((r) => r.type)).toEqual(['message', 'tools', 'message'])
    const group = rows[1]
    if (group.type !== 'tools') throw new Error('esperava grupo')
    const tools = toolEntries(group.entries)
    expect(tools.map((t) => t.use.name)).toEqual(['Read', 'Read', 'Bash'])
    expect(tools.map((t) => t.result?.content)).toEqual(['conteúdo a', 'conteúdo b', 'falhou'])
    expect(tools[2].result?.isError).toBe(true)
  })

  it('nenhum tool_result pareado sobra como linha solta', () => {
    const rows = buildChatRows(messages)
    const loose = rows.filter(
      (r) => r.type === 'message' && messages[r.index].kind === 'tool_result',
    )
    expect(loose).toHaveLength(0)
  })
})

describe('buildChatRows (casos de borda)', () => {
  const use = (id: string, name = 'Read'): ChatMessage => ({
    kind: 'tool_use',
    id,
    name,
    input: {},
  })
  const res = (forId: string): ChatMessage => ({
    kind: 'tool_result',
    forId,
    content: 'ok',
    isError: false,
  })

  it('resultado sem chamada correspondente continua visível', () => {
    const rows = buildChatRows([res('órfão')])
    expect(rows).toEqual([{ type: 'message', index: 0 }])
  })

  it('raciocínio entre chamadas fica dentro do grupo; sozinho, não vira grupo', () => {
    const msgs: ChatMessage[] = [
      use('a'),
      { kind: 'thinking', text: 'hmm' },
      use('b'),
      res('a'),
      res('b'),
    ]
    const rows = buildChatRows(msgs)
    expect(rows).toHaveLength(1)
    expect(rows[0].type === 'tools' && rows[0].entries.map((e) => e.kind)).toEqual([
      'tool',
      'thinking',
      'tool',
    ])
    expect(buildChatRows([{ kind: 'thinking', text: 'só pensei' }])).toEqual([
      { type: 'message', index: 0 },
    ])
  })

  it('raciocínio antes da primeira e depois da última chamada fica fora do grupo', () => {
    const think = (t: string): ChatMessage => ({ kind: 'thinking', text: t })
    const msgs: ChatMessage[] = [think('antes'), use('a'), use('b'), think('depois')]
    const rows = buildChatRows(msgs)
    expect(rows.map((r) => [r.type, r.index])).toEqual([
      ['message', 0],
      ['tools', 1],
      ['message', 3],
    ])
  })

  it('índices de artefato não entram em grupo e os escondidos somem', () => {
    const msgs: ChatMessage[] = [
      use('a'),
      use('art', 'mcp__pitwall__diagram_get'),
      res('art'),
      use('b'),
    ]
    const rows = buildChatRows(msgs, new Set([2]), new Set([1]))
    expect(rows.map((r) => r.type)).toEqual(['tools', 'message', 'tools'])
    expect(rows[1]).toEqual({ type: 'message', index: 1 })
  })
})

describe('ritmo vertical', () => {
  it('turno novo do humano ganha o maior respiro; partes da resposta ficam juntas', () => {
    expect(rowSpacing(null, 'turn')).toBe('')
    expect(rowSpacing('assistant', 'turn')).toBe('mt-8')
    expect(rowSpacing('turn', 'tools')).toBe('mt-5')
    expect(rowSpacing('tools', 'assistant')).toBe('mt-3')
    expect(rowSpacing('tools', 'aside')).toBe('mt-1.5')
  })

  it('classifica as linhas pelo papel', () => {
    const msgs: ChatMessage[] = [
      { kind: 'user', text: 'oi' },
      { kind: 'assistant', text: 'olá' },
    ]
    expect(rowRhythm({ type: 'message', index: 0 }, msgs)).toBe('turn')
    expect(rowRhythm({ type: 'message', index: 1 }, msgs)).toBe('assistant')
    expect(rowRhythm({ type: 'tools', index: 0, entries: [] }, msgs)).toBe('tools')
  })
})
