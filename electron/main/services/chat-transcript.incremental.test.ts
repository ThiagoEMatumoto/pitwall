import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../shared/types/chat'
import {
  createChatParser,
  parseChatMessages,
  parseSubagentTurns,
  parseTranscriptLines,
  rewoundUuids,
  type RawLine,
  type SubagentInfo,
} from './chat-transcript'
import { buildLongMotherLines } from './__fixtures__/long-mother-jsonl'

// Diferencial: o parser incremental tem de chegar à mesma lista que parseChatMessages
// sobre o arquivo inteiro, seja qual for o ponto em que o arquivo foi cortado em feeds.
const FIXTURES = join(__dirname, '../../../shared/tui/__fixtures__')
const REWIND = 'claude-2.1.318-rewind-e2e-restored.jsonl'
const fixtureLines = (name: string): string[] =>
  readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())

// Todo transcript real versionado (hook-spike-payloads é payload de hook, não transcript).
const REAL = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.jsonl') && !f.includes('hook-spike-payloads'))
  .map((f): [string, string[]] => [f, fixtureLines(f)])

// Ctrl+C numa ferramenta cujo tool_result só é gravado depois da linha de interrupção.
// Shapes das linhas: os mesmos de chat-transcript.test.ts ("interrupção por Ctrl+C").
const LATE_RESULT = [
  {
    type: 'assistant',
    message: {
      id: 'msg_int1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Vou rodar o comando.' },
        { type: 'tool_use', id: 'tu_tardio', name: 'Bash', input: { command: 'sleep 120' } },
      ],
    },
  },
  {
    type: 'user',
    interruptedMessageId: 'msg_int1',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
    },
  },
  {
    type: 'user',
    toolUseResult: { stdout: 'rodando…', stderr: '', interrupted: true, isImage: false },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_tardio', content: 'rodando…' }],
    },
  },
  {
    type: 'assistant',
    message: { id: 'msg_int2', role: 'assistant', content: [{ type: 'text', text: 'Parei.' }] },
  },
].map((l) => JSON.stringify(l))

const MOTHER = buildLongMotherLines(50)
// O turno 3 da mãe vira subagente: o tool_result dele dobra em subagent_result.
const SUBAGENTS = new Map<string, SubagentInfo>([
  [
    'toolu_turn3',
    {
      name: 'explorer',
      description: 'mapear o repo',
      ...parseSubagentTurns(buildLongMotherLines(2).join('\n')),
    },
  ],
])

const CASES: [string, string[], Map<string, SubagentInfo> | undefined][] = [
  ...REAL.map(([name, lines]): [string, string[], undefined] => [name, lines, undefined]),
  ['mãe longa (50 turnos)', MOTHER, undefined],
  ['mãe longa com subagente', MOTHER, SUBAGENTS],
  ['interrupção com tool_result atrasado', LATE_RESULT, undefined],
]

// O que o serviço faz com o resultado do feed: rewind → parser novo, com os ramos
// abandonados semeados por rewoundUuids, alimentado com o arquivo inteiro.
function incremental(subagents?: Map<string, SubagentInfo>) {
  let parser = createChatParser({ subagents })
  let seen: RawLine[] = []
  let rewinds = 0
  return {
    feed(chunk: RawLine[]): void {
      seen = [...seen, ...chunk]
      if (!parser.feed(chunk).rewind) return
      rewinds += 1
      parser = createChatParser({ subagents, dropped: rewoundUuids(seen) })
      expect(parser.feed(seen).rewind).toBe(false)
    },
    get parser() {
      return parser
    },
    get rewinds() {
      return rewinds
    },
  }
}

function firstDifference(before: readonly ChatMessage[], after: readonly ChatMessage[]): number {
  const i = before.findIndex((m, idx) => !isDeepStrictEqual(m, after[idx]))
  return i === -1 ? before.length : i
}

describe('createChatParser — diferencial contra parseChatMessages', () => {
  it('cobre os transcripts reais do repo', () => {
    expect(REAL.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'claude-2.1.286-send-message.jsonl',
        'claude-2.1.317-compact-done.jsonl',
        'claude-2.1.317-plan-auto-after-approve.jsonl',
        REWIND,
      ]),
    )
  })

  it.each(CASES)('%s: feed(prefixo) + feed(resto) em todo ponto de corte', (_n, raw, subagents) => {
    const lines = parseTranscriptLines(raw.join('\n'))
    const full = parseChatMessages(raw.join('\n'), subagents)
    expect(full.length).toBeGreaterThan(0)

    for (let k = 0; k <= lines.length; k++) {
      const inc = incremental(subagents)
      inc.feed(lines.slice(0, k))
      const before = [...inc.parser.messages]
      inc.parser.takeDirty()
      const parserBefore = inc.parser

      inc.feed(lines.slice(k))
      const dirty = inc.parser.takeDirty()
      const after = inc.parser.messages

      expect(after, `corte ${k}`).toStrictEqual(full)
      expect(dirty, `corte ${k}`).toBeLessThanOrEqual(firstDifference(before, after))
      // Abaixo do índice sujo o objeto é o mesmo: é o que deixa o renderer preservar identidade.
      if (inc.parser === parserBefore) {
        for (let i = 0; i < dirty; i++) expect(after[i], `corte ${k}, índice ${i}`).toBe(before[i])
      }
    }
  })

  it.each(CASES)('%s: linha a linha, igual ao parse completo do prefixo', (_n, raw, subagents) => {
    const lines = parseTranscriptLines(raw.join('\n'))
    const inc = incremental(subagents)
    for (let k = 0; k < lines.length; k++) {
      inc.feed([lines[k]])
      expect(inc.parser.messages, `até a linha ${k}`).toStrictEqual(
        parseChatMessages(raw.slice(0, k + 1).join('\n'), subagents),
      )
    }
  })
})

describe('createChatParser — rewind', () => {
  const raw = fixtureLines(REWIND)
  const lines = parseTranscriptLines(raw.join('\n'))
  const forkAt = raw.findIndex((l) => l.includes('Responda só: ok depois.'))

  it('sinaliza no segundo prompt com o mesmo pai, e só nele', () => {
    expect(forkAt).toBeGreaterThan(0)
    const parser = createChatParser()
    lines.slice(0, forkAt).forEach((l, i) => {
      expect(parser.feed([l]).rewind, `linha ${i}`).toBe(false)
    })
    expect(parser.feed([lines[forkAt]]).rewind).toBe(true)
  })

  it('não consome nada do lote que sinalizou', () => {
    const parser = createChatParser()
    parser.feed(lines.slice(0, forkAt - 2))
    parser.takeDirty()
    const before = [...parser.messages]

    expect(parser.feed(lines.slice(forkAt - 2)).rewind).toBe(true)

    expect(parser.messages).toStrictEqual(before)
    expect(parser.takeDirty()).toBe(before.length)
    // O estado segue íntegro: o mesmo lote sem a bifurcação entra normalmente.
    expect(parser.feed(lines.slice(forkAt - 2, forkAt)).rewind).toBe(false)
    expect(parser.messages).toStrictEqual(parseChatMessages(raw.slice(0, forkAt).join('\n')))
  })

  it('semeado com os descartados, não sinaliza e descarta o ramo abandonado', () => {
    const parser = createChatParser({ dropped: rewoundUuids(lines) })
    expect(parser.feed(lines).rewind).toBe(false)
    expect(parser.messages).toStrictEqual(parseChatMessages(raw.join('\n')))
  })

  it('transcripts sem rewind nunca sinalizam', () => {
    for (const [name, rawLines] of REAL.filter(([n]) => n !== REWIND)) {
      const inc = incremental()
      for (const l of parseTranscriptLines(rawLines.join('\n'))) inc.feed([l])
      expect(inc.rewinds, name).toBe(0)
    }
  })

  it('não altera o conjunto de descartados recebido', () => {
    const dropped = rewoundUuids(lines)
    const size = dropped.size
    createChatParser({ dropped }).feed(lines)
    expect(dropped.size).toBe(size)
  })
})

describe('createChatParser — interrupção recalculada a cada feed', () => {
  const lines = parseTranscriptLines(LATE_RESULT.join('\n'))
  const toolUse = (messages: readonly ChatMessage[]) => messages.find((m) => m.kind === 'tool_use')

  it('marca o tool_use órfão e desfaz a marca quando o tool_result chega depois', () => {
    const parser = createChatParser()
    parser.feed(lines.slice(0, 2))
    expect(toolUse(parser.messages)).toMatchObject({ name: 'Bash', interrupted: true })
    expect(parser.messages.find((m) => m.kind === 'assistant')).toMatchObject({ interrupted: true })
    parser.takeDirty()

    parser.feed(lines.slice(2, 3))

    expect(toolUse(parser.messages)).not.toHaveProperty('interrupted')
    // O texto do turno cortado continua marcado: só a ferramenta respondeu.
    expect(parser.messages.find((m) => m.kind === 'assistant')).toMatchObject({ interrupted: true })
    expect(parser.takeDirty()).toBe(parser.messages.findIndex((m) => m.kind === 'tool_use'))
  })

  it('feed sem novidade para o turno interrompido não suja mensagens antigas', () => {
    const parser = createChatParser()
    parser.feed(lines.slice(0, 3))
    parser.takeDirty()
    const length = parser.messages.length

    parser.feed(lines.slice(3))

    expect(parser.takeDirty()).toBe(length)
  })
})

describe('createChatParser — takeDirty', () => {
  it('devolve messages.length quando nada mudou desde a última chamada', () => {
    const parser = createChatParser()
    expect(parser.takeDirty()).toBe(0)
    parser.feed(parseTranscriptLines(buildLongMotherLines(1).join('\n')))
    expect(parser.takeDirty()).toBe(0)
    expect(parser.takeDirty()).toBe(parser.messages.length)
    parser.feed([])
    expect(parser.takeDirty()).toBe(parser.messages.length)
  })

  it('aponta a mensagem do assistant que o merge de texto adjacente trocou', () => {
    const text = (t: string) =>
      ({
        type: 'assistant',
        message: { id: 'msg_merge', role: 'assistant', content: [{ type: 'text', text: t }] },
      }) as RawLine
    const parser = createChatParser()
    parser.feed([text('primeira parte')])
    parser.takeDirty()

    parser.feed([text('segunda parte')])

    expect(parser.messages).toStrictEqual([
      { kind: 'assistant', text: 'primeira parte\n\nsegunda parte' },
    ])
    expect(parser.takeDirty()).toBe(0)
  })
})
