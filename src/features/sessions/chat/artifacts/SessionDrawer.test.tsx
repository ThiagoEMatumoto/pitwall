import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { on, emit, handlers, askSession, pushEcho, state } = vi.hoisted(() => {
  type Handler = (payload: unknown) => void
  const handlers = new Map<string, Set<Handler>>()
  const on = (channel: string) => (h: Handler) => {
    if (!handlers.has(channel)) handlers.set(channel, new Set())
    handlers.get(channel)!.add(h)
    return () => handlers.get(channel)!.delete(h)
  }
  const emit = (channel: string, payload: unknown): void => {
    for (const h of handlers.get(channel) ?? []) h(payload)
  }
  const state = { links: [] as Array<{ parentType: string; parentId: string }> }
  return { on, emit, handlers, askSession: vi.fn(async () => {}), pushEcho: vi.fn(), state }
})

vi.mock('@/lib/ipc', () => ({
  diagramsApi: {
    get: vi.fn(async (id: string) => ({ id, title: 'Arq', links: state.links })),
    onLinksUpdated: on('diagramLinks:updated'),
  },
  designApi: {
    askSession,
    documentGet: vi.fn(async () => null),
    onLinksUpdated: on('design:links-updated'),
    onAgentActivity: on('design:agent-activity'),
  },
}))

vi.mock('@/features/design/ask-claude/useSessionTargets', () => ({
  useSessionTargets: () => ({
    targets: [{ sessionId: 's-other', label: 'Outra sessão', detail: 'Projeto', paneId: null }],
    defaultTarget: null,
  }),
}))

vi.mock('@/store/appStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) =>
    sel({
      liveSessions: [
        {
          id: 's-author',
          ccSessionId: 'cc-author',
          title: 'Autora',
          status: 'ended',
          projectName: 'P',
        },
      ],
    }),
}))

vi.mock('../ChatView', () => ({
  ChatView: forwardRef(function ChatViewStub({ sessionId }: { sessionId: string }, ref) {
    useImperativeHandle(ref, () => ({ pushEcho }))
    return <div data-testid="chat">{sessionId}</div>
  }),
}))

import { SessionDrawerButton, artifactPrompt } from './SessionDrawer'

const ref = { kind: 'diagram' as const, id: 'd1' }

beforeEach(() => {
  handlers.clear()
  askSession.mockClear()
  pushEcho.mockClear()
  state.links = []
})

describe('SessionDrawer', () => {
  it('sem sessão vinculada oferece escolher uma aberta', async () => {
    render(<SessionDrawerButton artifact={ref} title="Arq" />)
    fireEvent.click(screen.getByRole('button', { name: /Sessão/ }))
    expect(
      await screen.findByText('Nenhuma sessão escreveu este diagrama ainda.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Escolha uma sessão aberta acima para conversar sobre ele.'),
    ).toBeInTheDocument()
  })

  it('abre na sessão autora, vinda do link; encerrada fica só leitura', async () => {
    state.links = [{ parentType: 'session', parentId: 's-author' }]
    render(<SessionDrawerButton artifact={ref} title="Arq" />)
    fireEvent.click(screen.getByRole('button', { name: /Sessão/ }))
    expect(await screen.findByTestId('chat')).toHaveTextContent('s-author')
    expect(screen.getByLabelText('Mensagem para a sessão')).toBeDisabled()
  })

  it('link novo chega ao vivo e o envio passa pelo ask-session com o artefato', async () => {
    render(<SessionDrawerButton artifact={ref} title="Arq" />)
    fireEvent.click(screen.getByRole('button', { name: /Sessão/ }))
    await screen.findByText('Nenhuma sessão escreveu este diagrama ainda.')
    act(() =>
      emit('diagramLinks:updated', {
        diagramId: 'd1',
        links: [{ diagramId: 'd1', parentType: 'session', parentId: 's-other' }],
      }),
    )
    expect(await screen.findByTestId('chat')).toHaveTextContent('s-other')
    const box = screen.getByLabelText('Mensagem para a sessão')
    fireEvent.change(box, { target: { value: 'adiciona o cache' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    const prompt = artifactPrompt(ref, 'Arq', 'adiciona o cache')
    await waitFor(() =>
      expect(askSession).toHaveBeenCalledWith({ sessionId: 's-other', prompt, submit: true }),
    )
    expect(pushEcho).toHaveBeenCalledWith(prompt)
  })
})
