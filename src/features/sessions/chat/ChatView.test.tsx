import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseTuiMenu } from '../../../../shared/tui/tui-menu-parser'
import type { ChatMessage } from '../../../../shared/types/chat'

const { sessionsApiMock, transcript } = vi.hoisted(() => ({
  sessionsApiMock: { attentionMenu: vi.fn(), attentionRespond: vi.fn() },
  transcript: { messages: [] as ChatMessage[] },
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
  usePlanFile: () => null,
}))

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', getVersion: () => '0' } }))

import { ChatView } from './ChatView'
import { PlanCard } from './PlanCard'
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

describe('PlanCard', () => {
  it('atalho de aprovar usa tecla com ícone, nunca o glifo ⏎', () => {
    render(<PlanCard plan="# Plano" onDecide={() => {}} />)
    const hints = screen.getByTestId('plan-shortcuts')
    expect(hints.textContent).not.toContain('⏎')
    expect(hints.querySelector('kbd svg')).toBeTruthy()
  })
})
