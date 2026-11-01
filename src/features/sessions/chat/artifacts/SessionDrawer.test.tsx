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
  sessionsApi: { currentIds: async (ids: string[]) => ids },
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

import { SessionDrawerButton, SessionDrawerDock, artifactPrompt } from './SessionDrawer'
import { DRAWER_DEFAULT_WIDTH, useSessionDrawerStore } from './sessionDrawerStore'

const ref = { kind: 'diagram' as const, id: 'd1' }

beforeEach(() => {
  handlers.clear()
  askSession.mockClear()
  pushEcho.mockClear()
  state.links = []
  useSessionDrawerStore.setState({ openKey: null, width: DRAWER_DEFAULT_WIDTH })
})

// Como nos editores: botão na toolbar, dock como coluna irmã do canvas.
function Editor() {
  return (
    <div className="flex">
      <SessionDrawerButton artifact={ref} title="Arq" />
      <div data-testid="canvas" />
      <SessionDrawerDock artifact={ref} title="Arq" />
    </div>
  )
}

describe('SessionDrawer', () => {
  it('abre como coluna ao lado do canvas (empurra, não cobre) e redimensiona', () => {
    render(<Editor />)
    fireEvent.click(screen.getByRole('button', { name: /Sessão/ }))
    const drawer = screen.getByRole('complementary', { name: 'Sessão de Arq' })
    expect(drawer.className).not.toMatch(/\bfixed\b|\babsolute\b/)
    expect(drawer.className).toContain('shrink-0')
    expect(screen.getByTestId('canvas').nextElementSibling).toBe(drawer)
    const handle = screen.getByRole('separator', { name: 'Redimensionar gaveta da sessão' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(useSessionDrawerStore.getState().width).toBe(DRAWER_DEFAULT_WIDTH + 24)
    fireEvent.click(screen.getByRole('button', { name: /Sessão/ }))
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('sem sessão vinculada oferece escolher uma aberta', async () => {
    render(<Editor />)
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
    render(<Editor />)
    fireEvent.click(screen.getByRole('button', { name: /Sessão/ }))
    expect(await screen.findByTestId('chat')).toHaveTextContent('s-author')
    expect(screen.getByLabelText('Mensagem para a sessão')).toBeDisabled()
  })

  it('link novo chega ao vivo e o envio passa pelo ask-session com o artefato', async () => {
    render(<Editor />)
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
