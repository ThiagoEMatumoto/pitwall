import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Transcript longo de uma "mãe" para os testes da cauda (chat:watch-tail).
//
// Origem: o envelope de cada linha (parentUuid, uuid, timestamp, sessionId,
// version, cwd, gitBranch, userType, entrypoint, message.model/usage/stop_*) é
// copiado da linha real e já redigida do claude 2.1.286 versionada em
// shared/tui/__fixtures__/claude-2.1.286-send-message.jsonl. Só o conteúdo dos
// blocos (texto, tool_use, tool_result) é gerado, de forma determinística.
// Não copiamos um JSONL de ~/.claude/projects: o repo é público e transcripts
// reais carregam caminhos, código e conversa privados.
const REAL_LINE = readFileSync(
  join(__dirname, '../../../../shared/tui/__fixtures__/claude-2.1.286-send-message.jsonl'),
  'utf8',
).split('\n')[0]

type Json = Record<string, unknown>
const REAL = JSON.parse(REAL_LINE) as Json & { message: Json }

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const filler = (seed: number, len: number) => {
  const words = ['room', 'tile', 'mother', 'child', 'queue', 'tail', 'watch', 'pane', 'lease']
  let out = ''
  for (let i = 0; out.length < len; i++) out += words[(seed + i * 7) % words.length] + ' '
  return out.slice(0, len)
}

function envelope(n: number, type: 'user' | 'assistant'): Json {
  const {
    message: _m,
    wireToolInputs: _w,
    serverClassifierRequest: _s,
    apiBlockIndex: _a,
    requestId: _r,
    ...rest
  } = REAL
  return {
    ...rest,
    type,
    parentUuid: n === 0 ? null : uuid(n - 1),
    uuid: uuid(n),
    timestamp: new Date(Date.UTC(2026, 8, 30, 20, 0, 0) + n * 1000).toISOString(),
  }
}

function assistantLine(n: number, msgId: string, content: Json[]): string {
  const { content: _c, ...msg } = REAL.message
  return JSON.stringify({
    ...envelope(n, 'assistant'),
    message: { ...msg, id: msgId, content },
  })
}

function userLine(n: number, content: unknown, extra: Json = {}): string {
  return JSON.stringify({ ...envelope(n, 'user'), ...extra, message: { role: 'user', content } })
}

// Turno: prompt → texto do assistant → tool_use (mesmo message.id, linha
// separada, como o CLI grava no streaming) → tool_result → texto final.
export function buildLongMotherLines(turns: number, resultBytes = 4096): string[] {
  const lines: string[] = []
  let n = 0
  for (let t = 0; t < turns; t++) {
    const msgA = `msg_turn${t}_a`
    const toolId = `toolu_turn${t}`
    lines.push(userLine(n++, `pedido ${t}: ${filler(t, 120)}`))
    lines.push(
      assistantLine(n++, msgA, [{ type: 'text', text: `vou olhar ${t}. ${filler(t + 1, 200)}` }]),
    )
    lines.push(
      assistantLine(n++, msgA, [
        { type: 'tool_use', id: toolId, name: 'Bash', input: { command: `ls turn-${t}` } },
      ]),
    )
    lines.push(
      userLine(
        n++,
        [
          {
            type: 'tool_result',
            tool_use_id: toolId,
            content: filler(t + 2, resultBytes),
            is_error: false,
          },
        ],
        { toolUseResult: { stdout: '', stderr: '', interrupted: false } },
      ),
    )
    lines.push(
      assistantLine(n++, `msg_turn${t}_b`, [
        { type: 'text', text: `pronto ${t}. ${filler(t + 3, 160)}` },
      ]),
    )
  }
  return lines
}

// Mesmo transcript, com um último tool_result do tamanho pedido (força a janela
// da cauda a crescer, ou a desistir acima do teto).
export function withHugeLastResult(lines: string[], bytes: number): string[] {
  const n = lines.length
  const toolId = 'toolu_huge'
  return [
    ...lines,
    assistantLine(n, 'msg_huge', [
      { type: 'tool_use', id: toolId, name: 'Read', input: { file_path: '/repo/big.log' } },
    ]),
    userLine(n + 1, [
      { type: 'tool_result', tool_use_id: toolId, content: filler(n, bytes), is_error: false },
    ]),
  ]
}

export { assistantLine as realShapeAssistantLine }
