import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PromptQueueSnapshot, QueuedPrompt } from '../../../shared/types/send-prompt'

vi.mock('@/lib/ipc', () => ({
  notificationsApi: { onEvent: () => () => {}, onOpenSession: () => () => {} },
  sendToApi: {},
  sessionsApi: {},
}))

const { watchMaybeUndelivered } = await import('./maybe-undelivered-toasts')
const { NotificationToast } = await import('@/features/notifications/NotificationToast')
const { useToastStore, showToast, dismissToast } =
  await import('@/features/notifications/toast-store')

function item(id: string, recovery?: QueuedPrompt['recovery']): QueuedPrompt {
  return {
    id,
    sessionId: `pty-${id}`,
    text: `texto ${id}`,
    createdAt: 0,
    expiresAt: 0,
    heldByMenu: 0,
    heldReason: null,
    recovery,
  }
}

function snap(items: QueuedPrompt[]): PromptQueueSnapshot {
  return { items, counters: {} as PromptQueueSnapshot['counters'], lastEvent: null }
}

function setup(boot: QueuedPrompt[] = []) {
  let push: (s: PromptQueueSnapshot) => void = () => {}
  const deps = {
    queue: vi.fn(async () => snap(boot)),
    onQueueUpdated: vi.fn((h: (s: PromptQueueSnapshot) => void) => {
      push = h
      return () => {}
    }),
    resend: vi.fn(async () => true),
    cancel: vi.fn(async () => true),
    titleOf: vi.fn(async (sid: string) => `Sessão ${sid}`),
    show: showToast,
    dismiss: dismissToast,
  }
  const stop = watchMaybeUndelivered(deps)
  return { deps, stop, push: (s: PromptQueueSnapshot) => act(async () => push(s)) }
}

async function flush() {
  await act(async () => {})
}

afterEach(() => act(() => useToastStore.setState({ toasts: [] })))

describe('watchMaybeUndelivered', () => {
  it('esperando a conversa (waitingNotice): aviso com Enviar quando voltar / Descartar', async () => {
    const waiting = { ...item('w', 'awaiting-session'), waitingNotice: true as const }
    const { deps, stop } = setup([waiting, item('quieto', 'awaiting-session')])
    await flush()
    await flush()
    render(<NotificationToast />)
    expect(screen.getAllByText(/Aguardando a conversa/)).toHaveLength(1)
    fireEvent.click(screen.getByText('Enviar quando voltar'))
    expect(deps.resend).not.toHaveBeenCalled()
    expect(deps.cancel).not.toHaveBeenCalled()
    stop()
  })

  it('esperando a conversa: Descartar cancela o item', async () => {
    const waiting = { ...item('d', 'awaiting-session'), waitingNotice: true as const }
    const { deps, stop } = setup([waiting])
    await flush()
    await flush()
    render(<NotificationToast />)
    fireEvent.click(screen.getByText('Descartar'))
    expect(deps.cancel).toHaveBeenCalledWith('d')
    stop()
  })

  it('item velho restaurado (needs-confirmation) pede Enviar/Descartar', async () => {
    const { deps, stop } = setup([item('v', 'needs-confirmation')])
    await flush()
    await flush()
    render(<NotificationToast />)
    expect(screen.getByText(/ficou na fila desde .* enviar agora\?/)).toBeTruthy()
    fireEvent.click(screen.getByText('Enviar'))
    expect(deps.resend).toHaveBeenCalledWith('v')
    stop()
  })

  it('evento maybe-undelivered mostra toast persistente com Reenviar e Descartar', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<NotificationToast />)
      const { push } = setup()
      await flush()
      await push(snap([item('a', 'maybe-undelivered'), item('b')]))
      await flush()

      expect(
        screen.getByText('Mensagem para Sessão pty-a talvez não tenha sido entregue'),
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Reenviar' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Descartar' })).toBeInTheDocument()
      expect(useToastStore.getState().toasts).toHaveLength(1)

      act(() => vi.advanceTimersByTime(60_000))
      expect(useToastStore.getState().toasts).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Reenviar chama prompt-queue:resend e fecha o toast; snapshot atrasado não reabre', async () => {
    render(<NotificationToast />)
    const { deps, push } = setup()
    await flush()
    await push(snap([item('a', 'maybe-undelivered')]))
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Reenviar' }))
    expect(deps.resend).toHaveBeenCalledWith('a')
    expect(deps.cancel).not.toHaveBeenCalled()
    expect(useToastStore.getState().toasts).toHaveLength(0)

    await push(snap([item('a', 'maybe-undelivered')]))
    await flush()
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('Descartar cancela o item', async () => {
    render(<NotificationToast />)
    const { deps, push } = setup()
    await flush()
    await push(snap([item('a', 'maybe-undelivered')]))
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    expect(deps.cancel).toHaveBeenCalledWith('a')
    expect(deps.resend).not.toHaveBeenCalled()
  })

  it('itens maybe-undelivered do snapshot do boot aparecem, um toast por item', async () => {
    const { deps } = setup([
      item('a', 'maybe-undelivered'),
      item('b', 'awaiting-session'),
      item('c', 'maybe-undelivered'),
    ])
    await flush()

    expect(deps.queue).toHaveBeenCalledTimes(1)
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual([
      'Mensagem para Sessão pty-a talvez não tenha sido entregue',
      'Mensagem para Sessão pty-c talvez não tenha sido entregue',
    ])
  })

  it('item resolvido por outro caminho tira o toast', async () => {
    const { push } = setup([item('a', 'maybe-undelivered')])
    await flush()
    expect(useToastStore.getState().toasts).toHaveLength(1)

    await push(snap([]))
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })
})
