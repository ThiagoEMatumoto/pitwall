import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseTuiMenu } from '../../../../shared/tui/tui-menu-parser'
import type { ChatMessage } from '../../../../shared/types/chat'

const { sessionsApiMock, transcript } = vi.hoisted(() => ({
  sessionsApiMock: { attentionMenu: vi.fn(), attentionRespond: vi.fn() },
  transcript: { messages: [] as ChatMessage[], planFileText: null as string | null },
}))

// Qualquer outra api do preload: inerte (assinaturas devolvem o "off").
vi.mock('@/lib/ipc', () => {
  const inert = new Proxy(
    {},
    {
      get: (_t, key: string) =>
        key.startsWith('on') ? () => () => {} : () => Promise.resolve(null),
    },
  )
  return new Proxy(
    { sessionsApi: sessionsApiMock },
    { get: (t, key: string) => (t as Record<string, unknown>)[key] ?? inert },
  )
})
vi.mock('./useChatTranscript', () => ({
  useChatTranscript: () => ({
    messages: transcript.messages,
    loading: false,
    transcriptExists: true,
    lastPlanFilePath: null,
  }),
  usePlanFile: () => transcript.planFileText,
}))

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', getVersion: () => '0' } }))

import { ChatView } from './ChatView'
import { PlanCard } from './PlanCard'
import { PLAN_KEY_DELAY_MS } from './respond-keys'
import { formatWakeEnvelope } from '../../../../electron/main/services/handoff/handoff-wake'
import { parseChatMessages } from '../../../../electron/main/services/chat-transcript'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'

const capture = (name: string) =>
  parseTuiMenu(
    readFileSync(
      join(__dirname, `../../../../shared/tui/__fixtures__/claude-2.1.316-${name}.txt`),
      'utf8',
    ),
  )!

// jsdom não tem ResizeObserver; o ChatView o usa para colar no fim.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

beforeEach(() => {
  transcript.messages = []
  transcript.planFileText = null
  sessionsApiMock.attentionMenu.mockReset()
  sessionsApiMock.attentionRespond.mockReset()
})

describe('ChatView real com menuFromMain (quick look sem xterm)', () => {
  it('pedido lido do main vira card e Aprovar responde pelo attentionRespond guardado', async () => {
    sessionsApiMock.attentionMenu.mockResolvedValue({
      sessionId: 's-child',
      fingerprint: 'fp-main',
      menuSeq: 7,
      menu: capture('permission-bash-curl'),
    })
    sessionsApiMock.attentionRespond.mockResolvedValue({ ok: true })
    render(<ChatView sessionId="s-child" status="waiting" menuFromMain isChild />)

    fireEvent.click(await screen.findByTestId('permission-approve'))
    await waitFor(() =>
      expect(sessionsApiMock.attentionRespond).toHaveBeenCalledWith({
        sessionId: 's-child',
        fingerprint: 'fp-main',
        menuSeq: 7,
        action: { kind: 'select', optionIndex: 0 },
      }),
    )
    expect(await screen.findByTestId('permission-sent')).toBeTruthy()
  })
})

describe('ChatView — atualização das filhas', () => {
  // Texto do produtor real (formatWakeEnvelope), gravado pela CLI como turno
  // 'user' e lido pelo parser real do transcript.
  function wakeTranscript() {
    const env = formatWakeEnvelope(
      [
        {
          handoffId: 'h-42',
          alias: 'mauricio-greet',
          status: 'needs_input',
          reasons: ['asked'],
          body: 'Uso a API v2 ou v3?',
          truncated: false,
        },
      ],
      0,
    )
    const line = { type: 'user', uuid: 'u1', message: { role: 'user', content: env } }
    return parseChatMessages(JSON.stringify(line))
  }

  it('renderiza card nativo, nunca o XML cru', () => {
    transcript.messages = wakeTranscript()
    expect(transcript.messages[0]?.kind).toBe('user')
    const { container } = render(<ChatView sessionId="s-mae" status="idle" />)
    const card = screen.getByTestId('handoff-update-card')
    expect(card.textContent).toContain('mauricio-greet')
    expect(card.textContent).toContain('Pergunta pendente')
    expect(card.textContent).toContain('Uso a API v2 ou v3?')
    expect(container.textContent).not.toContain('<pitwall-handoff-update')
    expect(container.textContent).not.toContain('handoff-id=')
  })

  it('Responder abre a filha no quick look', () => {
    transcript.messages = wakeTranscript()
    const openPeek = vi.fn()
    useCrewDockStore.setState({ openPeek })
    render(<ChatView sessionId="s-mae" status="idle" />)
    fireEvent.click(screen.getByTestId('handoff-update-open'))
    expect(screen.getByTestId('handoff-update-open').textContent).toContain('Responder')
    expect(openPeek).toHaveBeenCalledWith('h-42')
  })
})

const fixture317 = (name: string) =>
  readFileSync(
    join(__dirname, `../../../../shared/tui/__fixtures__/claude-2.1.317-${name}`),
    'utf8',
  )

// A corrida do bug real: o tool_use do ExitPlanMode já está no JSONL e o diálogo
// continua aberto na tela (claude 2.1.317, sonda probe-chat-plan-2317).
describe('ChatView — plano pendente no JSONL com o diálogo ainda aberto', () => {
  function renderRace(onRespond = vi.fn()) {
    transcript.messages = parseChatMessages(fixture317('plan-default.jsonl'))
    const menu = parseTuiMenu(fixture317('plan-default.txt'))!
    const utils = render(
      <ChatView
        sessionId="s-plan"
        status="waiting"
        tuiMenu={menu}
        reparseMenu={() => parseTuiMenu(fixture317('plan-default.txt'))}
        onRespond={onRespond}
      />,
    )
    return { ...utils, onRespond }
  }

  it('um único card de plano, interativo, e sem o banner de ir ao terminal', () => {
    const { container } = renderRace()
    expect(screen.getAllByText('Plano pronto — sua decisão')).toHaveLength(1)
    expect(container.textContent).not.toContain('responda no compositor ou no terminal')
    expect(container.textContent).not.toContain('use o terminal')
  })

  it('um botão por opção real, com o modo explícito e o destaque do terminal marcado', () => {
    const { container } = renderRace()
    expect(screen.getByTestId('plan-choice-approve-auto').textContent).toContain(
      'Aprovar e ligar auto mode',
    )
    expect(screen.getByTestId('plan-choice-approve-auto').dataset.highlighted).toBe('true')
    expect(screen.getByTestId('plan-choice-approve-manual').textContent).toBe(
      'Aprovar com edições manuais',
    )
    expect(screen.getByTestId('plan-choice-approve-manual').dataset.highlighted).toBeUndefined()
    expect(container.textContent).not.toContain('Pra aprovar, use o terminal')
  })

  it('aprovar manda o dígito da opção escolhida', () => {
    const { onRespond } = renderRace()
    fireEvent.click(screen.getByTestId('plan-choice-approve-manual'))
    expect(onRespond).toHaveBeenCalledWith(['2'], undefined)
  })

  it('pedir mudanças: dígito do campo + paste + Enter, com respiro entre as teclas', () => {
    const { onRespond } = renderRace()
    fireEvent.change(screen.getByTestId('plan-feedback'), { target: { value: 'use bye.txt' } })
    fireEvent.click(screen.getByTestId('plan-feedback-send'))
    expect(onRespond).toHaveBeenCalledWith(
      ['3', '\x1b[200~use bye.txt\x1b[201~', '\r'],
      PLAN_KEY_DELAY_MS,
    )
  })

  it('descartar = Esc', () => {
    const { onRespond } = renderRace()
    fireEvent.click(screen.getByTestId('plan-choice-reject'))
    expect(onRespond).toHaveBeenCalledWith(['\x1b'], undefined)
  })

  it('diálogo mudou desde o render: não digita e avisa', () => {
    const onRespond = vi.fn()
    transcript.messages = parseChatMessages(fixture317('plan-default.jsonl'))
    render(
      <ChatView
        sessionId="s-plan"
        status="waiting"
        tuiMenu={parseTuiMenu(fixture317('plan-default.txt'))}
        reparseMenu={() => parseTuiMenu(fixture317('plan-no-auto.txt'))}
        onRespond={onRespond}
      />,
    )
    fireEvent.click(screen.getByTestId('plan-choice-approve-manual'))
    expect(onRespond).not.toHaveBeenCalled()
    expect(screen.getByTestId('plan-notice').textContent).toContain('mudou')
  })

  it('respondido pelo card: o diálogo sai antes do tool_result e o banner não volta', () => {
    const onRespond = vi.fn()
    const { rerender, container } = renderRace(onRespond)
    fireEvent.click(screen.getByTestId('plan-choice-approve-manual'))
    expect(onRespond).toHaveBeenCalledWith(['2'], undefined)
    rerender(<ChatView sessionId="s-plan" status="working" onRespond={onRespond} />)
    expect(screen.getAllByText('Plano pronto — sua decisão')).toHaveLength(1)
    expect(screen.getByTestId('plan-shortcuts')).toHaveTextContent('Decisão enviada…')
    expect(container.textContent).not.toContain('aguardando sua aprovação do plano')
  })

  // JSONL real com a decisão do plano LzMZ7q no formato que a CLI grava.
  function withDecision(toolUseResult: unknown, content: string) {
    const line = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_013zfPNQQ4TP4VVHVMLzMZ7q', content }],
      },
      toolUseResult,
    }
    return parseChatMessages(`${fixture317('plan-default.jsonl')}\n${JSON.stringify(line)}`)
  }

  it('aprovado: o card mostra o plano aprovado (toolUseResult.plan), não o input.plan antigo', () => {
    transcript.messages = withDecision(
      { plan: 'Criar saudacao.txt com ola.', isAgent: false, filePath: '~/.claude/plans/x.md' },
      'User has approved your plan. You can now start coding.',
    )
    const { container } = render(<ChatView sessionId="s-plan" status="idle" />)
    expect(container.textContent).toContain('Criar saudacao.txt com ola.')
    expect(container.textContent).not.toContain('hello.txt')
  })

  it('rejeitado: o card mostra o plano que estava no diálogo, não o input.plan antigo', () => {
    transcript.planFileText = 'Criar saudacao.txt com ola.'
    const { rerender, container } = renderRace()
    transcript.messages = withDecision(
      'User rejected tool use',
      "The user doesn't want to proceed with this tool use. The tool use was rejected.",
    )
    transcript.planFileText = null
    rerender(<ChatView sessionId="s-plan" status="idle" />)
    expect(container.textContent).toContain('Criar saudacao.txt com ola.')
    expect(container.textContent).not.toContain('hello.txt')
  })

  it('sem o menu vivo o card do transcript fica (e o banner também)', () => {
    transcript.messages = parseChatMessages(fixture317('plan-default.jsonl'))
    const { container } = render(<ChatView sessionId="s-plan" status="waiting" />)
    expect(screen.getAllByText('Plano pronto — sua decisão')).toHaveLength(1)
    expect(container.textContent).toContain('aguardando sua aprovação do plano')
  })
})

describe('PlanCard', () => {
  it('sem atalho de Enter: o Enter do terminal escolheria a opção destacada', () => {
    render(<PlanCard plan="# Plano" onDecide={() => {}} />)
    const hints = screen.getByTestId('plan-shortcuts')
    expect(hints.textContent).not.toContain('⏎')
    expect(hints.querySelector('kbd svg')).toBeNull()
    expect(hints.textContent).toContain('esc')
  })
})
