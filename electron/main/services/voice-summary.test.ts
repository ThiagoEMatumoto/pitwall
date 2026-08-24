/** @vitest-environment node */
// Resumo de fim de turno com transcript e runClaude mockados — o teste NUNCA
// chama `claude -p` nem lê JSONL real. Mesma técnica de voice-condense.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../../shared/types/chat'

vi.mock('./claude-cli', () => ({
  runClaude: vi.fn(),
  TEXT_ONLY_CLAUDE_ARGS: ['--tools', '', '--strict-mcp-config'],
}))
vi.mock('./chat-transcript-service', () => ({
  chatTranscriptService: { read: vi.fn() },
}))
vi.mock('./notify', () => ({ broadcast: vi.fn() }))

import { runClaude } from './claude-cli'
import { chatTranscriptService } from './chat-transcript-service'
import { broadcast } from './notify'
import {
  forgetSessionSummaries,
  isAutoSummaryEnabled,
  lastAssistantTurnText,
  maybeSummarizeTurn,
  scheduleTurnSummary,
  setAutoSummary,
  SETTLE_MS,
  setVoiceSessionFilter,
  SUMMARY_INSTRUCTION,
  summarizeNow,
  turnKey,
} from './voice-summary'

const user = (text: string): ChatMessage => ({ kind: 'user', text })
const assistant = (text: string): ChatMessage => ({ kind: 'assistant', text })
const toolUse = (id: string): ChatMessage => ({
  kind: 'tool_use',
  id,
  name: 'Bash',
  input: {},
})

// ids únicos por teste: o estado de dedupe do módulo é por sessão e não é resetado.
let seq = 0
const freshId = () => `sess-${++seq}`
// Sessão com o resumo automático ligado — o gate padrão dos testes do fluxo automático.
const enabledId = () => {
  const id = freshId()
  setAutoSummary(id, true)
  return id
}

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
  setVoiceSessionFilter(() => true) // por default toda sessão conta como exibida.
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

describe('maybeSummarizeTurn (resumo automático por sessão)', () => {
  it('sessão habilitada: resume via claude e broadcasta voice:summary', async () => {
    const id = enabledId()
    mockTranscript([user('faz X'), assistant('feito: X aplicado')])
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: 'Claude aplicou X.\n',
      stderr: '',
    })

    await maybeSummarizeTurn(id)

    expect(runClaude).toHaveBeenCalledTimes(1)
    const [args, opts] = vi.mocked(runClaude).mock.calls[0]
    expect(args[0]).toBe('-p')
    expect(args[1]).toBe(SUMMARY_INSTRUCTION + 'feito: X aplicado')
    // Guard-rail: o texto do transcript entra no prompt — o resumidor roda sem
    // NENHUMA tool (built-in ou MCP) e nunca executa ação a partir do conteúdo.
    expect(args.slice(2)).toEqual([
      '--output-format',
      'text',
      '--model',
      'haiku',
      '--tools',
      '',
      '--strict-mcp-config',
    ])
    expect(opts?.timeoutMs).toBe(60_000)
    expect(broadcast).toHaveBeenCalledWith('voice:summary', {
      ccSessionId: id,
      summary: 'Claude aplicou X.',
    })
  })

  it('sessão SEM resumo automático é gate de custo: nem o transcript é lido', async () => {
    mockTranscript([user('faz X'), assistant('feito')])

    await maybeSummarizeTurn(freshId()) // nunca passou por setAutoSummary(true)

    expect(chatTranscriptService.read).not.toHaveBeenCalled()
    expect(runClaude).not.toHaveBeenCalled()
  })

  it('desligar o toggle da sessão volta a silenciar', async () => {
    const id = enabledId()
    mockTranscript([user('faz X'), assistant('feito')])
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: 'Resumo.',
      stderr: '',
    })

    setAutoSummary(id, false)
    await maybeSummarizeTurn(id)

    expect(chatTranscriptService.read).not.toHaveBeenCalled()
    expect(isAutoSummaryEnabled(id)).toBe(false)
  })

  it('permission prompt (última mensagem tool_use) não resume nem gasta claude', async () => {
    mockTranscript([user('faz X'), assistant('vou rodar'), toolUse('t1')])

    await maybeSummarizeTurn(enabledId())

    expect(runClaude).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('sessão que o Pitwall não exibe (terminal externo, filha de crew) nem lê o transcript', async () => {
    setVoiceSessionFilter(() => false)
    mockTranscript([user('faz X'), assistant('feito')])

    await maybeSummarizeTurn(enabledId())

    expect(chatTranscriptService.read).not.toHaveBeenCalled()
    expect(runClaude).not.toHaveBeenCalled()
  })

  it('turno novo chegando com resumo em voo não é dropado: re-roda ao terminar', async () => {
    const id = enabledId()
    let release!: (v: Awaited<ReturnType<typeof chatTranscriptService.read>>) => void
    vi.mocked(chatTranscriptService.read).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: 'Resumo.',
      stderr: '',
    })

    const first = maybeSummarizeTurn(id) // turno A em voo (transcript pendente)
    await maybeSummarizeTurn(id) // borda do turno B chega com A em voo
    // O turno B pousa no transcript; o rerun coalescido deve lê-lo ao fim de A.
    mockTranscript([user('faz A'), assistant('feito A'), user('faz B'), assistant('feito B')])
    release({
      ccSessionId: id,
      path: '/tmp/x.jsonl',
      mtimeMs: 1,
      messages: [user('faz A'), assistant('feito A')],
      lastPlanFilePath: null,
    })
    await first
    await vi.waitFor(() => expect(runClaude).toHaveBeenCalledTimes(2))

    expect(vi.mocked(runClaude).mock.calls[1][0][1]).toBe(SUMMARY_INSTRUCTION + 'feito B')
    expect(broadcast).toHaveBeenCalledTimes(2)
  })

  it('lock por sessão: disparo concorrente do mesmo turno resume UMA vez', async () => {
    const id = enabledId()
    let release!: (v: Awaited<ReturnType<typeof chatTranscriptService.read>>) => void
    vi.mocked(chatTranscriptService.read).mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: 'Resumo.',
      stderr: '',
    })

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

    // O disparo que bateu no lock vira rerun coalescido: re-lê o transcript ao
    // fim do voo (2ª leitura), mas o dedupe por hash impede um 2º claude.
    await vi.waitFor(() => expect(chatTranscriptService.read).toHaveBeenCalledTimes(2))
    expect(runClaude).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('mesmo turno visto de novo (borda repicou) não resume duas vezes', async () => {
    const id = enabledId()
    mockTranscript([user('faz X'), assistant('feito: X aplicado')])
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: 'Resumo.',
      stderr: '',
    })

    await maybeSummarizeTurn(id)
    await maybeSummarizeTurn(id)

    expect(runClaude).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('turno NOVO na mesma sessão resume de novo', async () => {
    const id = enabledId()
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: 'Resumo.',
      stderr: '',
    })
    mockTranscript([user('faz X'), assistant('feito X')])
    await maybeSummarizeTurn(id)
    mockTranscript([user('faz X'), assistant('feito X'), user('faz Y'), assistant('feito Y')])
    await maybeSummarizeTurn(id)

    expect(runClaude).toHaveBeenCalledTimes(2)
    expect(vi.mocked(runClaude).mock.calls[1][0][1]).toBe(SUMMARY_INSTRUCTION + 'feito Y')
  })

  it('falha do claude (exit != 0) não broadcasta e não re-tenta o turno', async () => {
    const id = enabledId()
    mockTranscript([user('faz X'), assistant('feito')])
    vi.mocked(runClaude).mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'boom',
    })

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

describe('summarizeNow (resumo sob demanda)', () => {
  it('bypassa o gate automático: resume sessão que nunca ligou o toggle', async () => {
    const id = freshId() // sem setAutoSummary — o gate automático barraria.
    mockTranscript([user('faz X'), assistant('feito: X aplicado')])
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: 'Resumo sob demanda.',
      stderr: '',
    })

    const res = await summarizeNow(id)

    expect(res).toEqual({ ok: true })
    expect(broadcast).toHaveBeenCalledWith('voice:summary', {
      ccSessionId: id,
      summary: 'Resumo sob demanda.',
    })
  })

  it('bypassa o dedupe: pedir de novo o MESMO turno resume de novo', async () => {
    const id = freshId()
    mockTranscript([user('faz X'), assistant('feito')])
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: 'Resumo.',
      stderr: '',
    })

    await summarizeNow(id)
    await summarizeNow(id)

    expect(runClaude).toHaveBeenCalledTimes(2)
    expect(broadcast).toHaveBeenCalledTimes(2)
  })

  it('respeita o lock: com resumo em voo, sai com erro sem 2º claude', async () => {
    const id = freshId()
    let release!: (v: Awaited<ReturnType<typeof chatTranscriptService.read>>) => void
    vi.mocked(chatTranscriptService.read).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: 'Resumo.',
      stderr: '',
    })

    const first = summarizeNow(id)
    const busy = await summarizeNow(id) // lock tomado → recusa na hora.

    expect(busy.ok).toBe(false)
    release({
      ccSessionId: id,
      path: '/tmp/x.jsonl',
      mtimeMs: 1,
      messages: [user('faz X'), assistant('feito')],
      lastPlanFilePath: null,
    })
    await first

    expect(runClaude).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('turno que não terminou em texto de assistant → erro em PT, sem claude', async () => {
    mockTranscript([user('faz X'), assistant('vou rodar'), toolUse('t1')])

    const res = await summarizeNow(freshId())

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('turno')
    expect(runClaude).not.toHaveBeenCalled()
  })

  it('claude que REJEITA (timeout/spawn) → erro do resumidor, não de transcript, e solta o lock', async () => {
    const id = freshId()
    mockTranscript([user('faz X'), assistant('feito')])
    vi.mocked(runClaude).mockRejectedValueOnce(new Error('spawn ETIMEDOUT'))

    const res = await summarizeNow(id)

    expect(res).toEqual({
      ok: false,
      error: 'Falha ao executar o resumidor (claude).',
    })
    expect(broadcast).not.toHaveBeenCalled()

    // Lock solto: um novo pedido roda claude de novo (agora com sucesso).
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: 'Resumo.',
      stderr: '',
    })
    const retry = await summarizeNow(id)
    expect(retry).toEqual({ ok: true })
  })

  it('falha na LEITURA do transcript → erro específico de transcript, sem claude', async () => {
    vi.mocked(chatTranscriptService.read).mockRejectedValueOnce(new Error('ENOENT'))

    const res = await summarizeNow(freshId())

    expect(res).toEqual({
      ok: false,
      error: 'Falha ao ler o transcript da sessão.',
    })
    expect(runClaude).not.toHaveBeenCalled()
  })

  it('sob demanda também alimenta o dedupe automático: a borda seguinte do mesmo turno não paga claude', async () => {
    const id = enabledId()
    mockTranscript([user('faz X'), assistant('feito')])
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: 'Resumo.',
      stderr: '',
    })

    await summarizeNow(id)
    await maybeSummarizeTurn(id) // mesma identidade de turno → dedupe.

    expect(runClaude).toHaveBeenCalledTimes(1)
  })
})

describe('turnKey / forgetSessionSummaries', () => {
  it('a identidade do turno é um sha1 do texto, não o texto integral', () => {
    const key = turnKey('um turno bem longo que não deve ficar retido em memória')
    expect(key).toMatch(/^[0-9a-f]{40}$/)
    expect(turnKey('a')).not.toBe(turnKey('b'))
    expect(turnKey('a')).toBe(turnKey('a'))
  })

  it('sessão esquecida (saiu do índice) perde o dedupe E o toggle automático', async () => {
    const id = enabledId()
    mockTranscript([user('faz X'), assistant('feito')])
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: 'Resumo.',
      stderr: '',
    })

    await maybeSummarizeTurn(id)
    forgetSessionSummaries(id)

    // O toggle morreu junto com a sessão: a borda seguinte não resume mais…
    expect(isAutoSummaryEnabled(id)).toBe(false)
    await maybeSummarizeTurn(id)
    expect(runClaude).toHaveBeenCalledTimes(1)

    // …e religar volta a resumir o mesmo turno (dedupe também foi esquecido).
    setAutoSummary(id, true)
    await maybeSummarizeTurn(id)
    expect(runClaude).toHaveBeenCalledTimes(2)
  })
})

describe('scheduleTurnSummary', () => {
  it('repiques dentro do settle colapsam num único resumo', async () => {
    vi.useFakeTimers()
    const id = enabledId()
    mockTranscript([user('faz X'), assistant('feito')])
    vi.mocked(runClaude).mockResolvedValue({
      code: 0,
      stdout: 'Resumo.',
      stderr: '',
    })

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
