/** @vitest-environment node */
// Resumo de fim de turno com transcript e runClaude mockados — o teste NUNCA
// chama `claude -p` nem lê JSONL real. Mesma técnica de voice-condense.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../../shared/types/chat'

vi.mock('./claude-cli', () => ({ runClaude: vi.fn() }))
vi.mock('./chat-transcript-service', () => ({ chatTranscriptService: { read: vi.fn() } }))
vi.mock('./prefs-store', () => ({ getPref: vi.fn() }))
vi.mock('./notify', () => ({ broadcast: vi.fn() }))

import { runClaude } from './claude-cli'
import { chatTranscriptService } from './chat-transcript-service'
import { getPref } from './prefs-store'
import { broadcast } from './notify'
import {
  lastAssistantTurnText,
  maybeSummarizeTurn,
  scheduleTurnSummary,
  SETTLE_MS,
  SUMMARY_INSTRUCTION,
  VOICE_MODE_PREF_KEY,
} from './voice-summary'

const user = (text: string): ChatMessage => ({ kind: 'user', text })
const assistant = (text: string): ChatMessage => ({ kind: 'assistant', text })
const toolUse = (id: string): ChatMessage => ({ kind: 'tool_use', id, name: 'Bash', input: {} })

// ids únicos por teste: o estado de dedupe do módulo é por sessão e não é resetado.
let seq = 0
const freshId = () => `sess-${++seq}`

function mockTranscript(messages: ChatMessage[]): void {
  vi.mocked(chatTranscriptService.read).mockResolvedValue({
    ccSessionId: 'x',
    path: '/tmp/x.jsonl',
    mtimeMs: 1,
    messages,
    lastPlanFilePath: null,
  })
}

beforeEach(() => {
  vi.mocked(runClaude).mockReset()
  vi.mocked(chatTranscriptService.read).mockReset()
  vi.mocked(broadcast).mockReset()
  vi.mocked(getPref).mockReset()
  vi.mocked(getPref).mockReturnValue(true) // modo voz ligado por default nos testes.
})

afterEach(() => {
  vi.useRealTimers()
})

describe('lastAssistantTurnText', () => {
  it('concatena os blocos assistant do último turno, parando na fronteira user', () => {
    const messages: ChatMessage[] = [
      user('turno velho'),
      assistant('resposta velha'),
      user('faz X'),
      assistant('começando'),
      toolUse('t1'),
      { kind: 'tool_result', forId: 't1', content: 'ok', isError: false },
      assistant('feito: X aplicado'),
    ]
    expect(lastAssistantTurnText(messages)).toBe('começando\n\nfeito: X aplicado')
  })

  it('última mensagem não-assistant (permission prompt / tool_use) → null', () => {
    expect(lastAssistantTurnText([user('faz X'), assistant('vou rodar'), toolUse('t1')])).toBeNull()
    expect(lastAssistantTurnText([])).toBeNull()
  })
})

describe('maybeSummarizeTurn', () => {
  it('turno terminado em texto de assistant: resume via claude e broadcasta voice:summary', async () => {
    const id = freshId()
    mockTranscript([user('faz X'), assistant('feito: X aplicado')])
    vi.mocked(runClaude).mockResolvedValue({ code: 0, stdout: 'Claude aplicou X.\n', stderr: '' })

    await maybeSummarizeTurn(id)

    expect(runClaude).toHaveBeenCalledTimes(1)
    const [args, opts] = vi.mocked(runClaude).mock.calls[0]
    expect(args[0]).toBe('-p')
    expect(args[1]).toBe(SUMMARY_INSTRUCTION + 'feito: X aplicado')
    expect(args.slice(2)).toEqual(['--output-format', 'text', '--model', 'haiku'])
    expect(opts?.timeoutMs).toBe(60_000)
    expect(broadcast).toHaveBeenCalledWith('voice:summary', {
      ccSessionId: id,
      summary: 'Claude aplicou X.',
    })
  })

  it('permission prompt (última mensagem tool_use) não resume nem gasta claude', async () => {
    mockTranscript([user('faz X'), assistant('vou rodar'), toolUse('t1')])

    await maybeSummarizeTurn(freshId())

    expect(runClaude).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('modo voz desligado é gate de custo: nem o transcript é lido', async () => {
    vi.mocked(getPref).mockReturnValue(false)

    await maybeSummarizeTurn(freshId())

    expect(vi.mocked(getPref).mock.calls[0]).toEqual([VOICE_MODE_PREF_KEY, false])
    expect(chatTranscriptService.read).not.toHaveBeenCalled()
    expect(runClaude).not.toHaveBeenCalled()
  })

  it('lock por sessão: disparo concorrente do mesmo turno resume UMA vez', async () => {
    const id = freshId()
    let release!: (v: Awaited<ReturnType<typeof chatTranscriptService.read>>) => void
    vi.mocked(chatTranscriptService.read).mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    vi.mocked(runClaude).mockResolvedValue({ code: 0, stdout: 'Resumo.', stderr: '' })

    const first = maybeSummarizeTurn(id)
    const second = maybeSummarizeTurn(id) // entra com o lock tomado → sai na hora.
    await second
    release({
      ccSessionId: id,
      path: '/tmp/x.jsonl',
      mtimeMs: 1,
      messages: [user('faz X'), assistant('feito')],
      lastPlanFilePath: null,
    })
    await first

    expect(chatTranscriptService.read).toHaveBeenCalledTimes(1)
    expect(runClaude).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('mesmo turno visto de novo (borda repicou) não resume duas vezes', async () => {
    const id = freshId()
    mockTranscript([user('faz X'), assistant('feito: X aplicado')])
    vi.mocked(runClaude).mockResolvedValue({ code: 0, stdout: 'Resumo.', stderr: '' })

    await maybeSummarizeTurn(id)
    await maybeSummarizeTurn(id)

    expect(runClaude).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('turno NOVO na mesma sessão resume de novo', async () => {
    const id = freshId()
    vi.mocked(runClaude).mockResolvedValue({ code: 0, stdout: 'Resumo.', stderr: '' })
    mockTranscript([user('faz X'), assistant('feito X')])
    await maybeSummarizeTurn(id)
    mockTranscript([user('faz X'), assistant('feito X'), user('faz Y'), assistant('feito Y')])
    await maybeSummarizeTurn(id)

    expect(runClaude).toHaveBeenCalledTimes(2)
    expect(vi.mocked(runClaude).mock.calls[1][0][1]).toBe(SUMMARY_INSTRUCTION + 'feito Y')
  })

  it('falha do claude (exit != 0) não broadcasta e não re-tenta o turno', async () => {
    const id = freshId()
    mockTranscript([user('faz X'), assistant('feito')])
    vi.mocked(runClaude).mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' })

    await maybeSummarizeTurn(id)
    await maybeSummarizeTurn(id)

    expect(runClaude).toHaveBeenCalledTimes(1)
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('o prompt pede 2-3 frases em PT e proíbe inventar', () => {
    expect(SUMMARY_INSTRUCTION).toContain('2 a 3 frases')
    expect(SUMMARY_INSTRUCTION).toContain('português')
    expect(SUMMARY_INSTRUCTION).toContain('NÃO invente')
    expect(SUMMARY_INSTRUCTION).toContain('precisa de algo do usuário')
  })
})

describe('scheduleTurnSummary', () => {
  it('repiques dentro do settle colapsam num único resumo', async () => {
    vi.useFakeTimers()
    const id = freshId()
    mockTranscript([user('faz X'), assistant('feito')])
    vi.mocked(runClaude).mockResolvedValue({ code: 0, stdout: 'Resumo.', stderr: '' })

    scheduleTurnSummary(id)
    vi.advanceTimersByTime(SETTLE_MS - 100)
    scheduleTurnSummary(id) // repique reseta o timer.
    vi.advanceTimersByTime(SETTLE_MS - 100)
    expect(chatTranscriptService.read).not.toHaveBeenCalled() // ainda dentro do settle.
    vi.advanceTimersByTime(100)
    await vi.runAllTimersAsync()

    expect(chatTranscriptService.read).toHaveBeenCalledTimes(1)
    expect(runClaude).toHaveBeenCalledTimes(1)
  })
})
