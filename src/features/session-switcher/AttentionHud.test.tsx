import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal(
  'window',
  Object.assign(window, {
    api: new Proxy(
      {},
      {
        get: () =>
          new Proxy(
            {},
            {
              get: (_t, m) =>
                m === 'attentionMenu' ? () => Promise.resolve(null) : () => undefined,
            },
          ),
      },
    ),
  }),
)

const { AttentionHud } = await import('./AttentionHud')
const { AttentionQueueButton } = await import('./AttentionPopover')
const { useAttentionStore } = await import('./useAttentionQueue')
const { useAppStore } = await import('@/store/appStore')
const { useHandoffsStore } = await import('@/store/handoffsStore')
const { useAttentionListStore } = await import('@/store/attentionStore')
const { projectAttention } = await import('../../../shared/attention/project-attention')
const { useCrewDockStore } = await import('@/features/handoffs/crew-dock-store')
type Handoff = import('../../../shared/types/ipc').Handoff
type LiveSessionInfo = import('../../../shared/types/ipc').LiveSessionInfo
type AttentionItem = import('./attention-queue').AttentionItem

const item: AttentionItem = {
  key: 'crew:h',
  kind: 'crew',
  sessionId: 'child',
  ccSessionId: 'cc-child',
  handoffId: 'h',
  projectName: 'proj',
  title: 'Auth',
  reason: 'handoff-input',
  since: 1,
  liveStatus: 'waiting',
}

afterEach(() => {
  vi.useRealTimers()
  useAttentionStore.setState({ flash: null, cursor: null, activeCc: null })
  useAppStore.setState({ liveSessions: [] })
  useHandoffsStore.setState({ handoffs: [] })
  useAttentionListStore.setState({ items: [] })
  useCrewDockStore.setState({ peekId: null })
})

// Filha do dock (sem aba) esperando numa permissão: entra na fila como crew.
function seedCrewChild(status: LiveSessionInfo['status'] = 'waiting') {
  useHandoffsStore.setState({
    handoffs: [
      {
        id: 'h',
        status: 'running',
        childSessionId: 'child',
        dismissedAt: null,
        questionAskedAt: null,
        stepUpdatedAt: null,
        task: 'Auth',
      } as unknown as Handoff,
    ],
  })
  useAppStore.setState({
    liveSessions: [
      {
        id: 'child',
        ccSessionId: 'cc-child',
        status,
        attentionReason: status === 'waiting' ? 'permission' : undefined,
        projectName: 'proj',
        title: 'Auth',
        lastActivityAt: 1,
      } as unknown as LiveSessionInfo,
    ],
  })
  // A fila vem da projeção do main; aqui a mesma função sobre o mesmo estado.
  useAttentionListStore.setState({
    items: projectAttention({
      handoffs: useHandoffsStore.getState().handoffs,
      transitions: new Map(),
      requests: [],
      dismissals: new Map(),
      live: [
        {
          sessionId: 'child',
          status,
          screenReason: status === 'waiting' ? 'permission' : undefined,
          menuSeq: status === 'waiting' ? 1 : null,
          lastActivityAt: 1,
          featureId: null,
          repoId: null,
        },
      ],
    }),
  })
}

const permissionItem: AttentionItem = { ...item, reason: 'crew', detail: 'permission' }

function pin() {
  act(() => useCrewDockStore.setState({ peekId: 'h' }))
  act(() =>
    useAttentionStore.setState({
      flash: { nonce: 1, position: 1, total: 1, item: permissionItem },
    }),
  )
}

describe('AttentionHud — popover fixado', () => {
  it('fecha de vez quando o item sai da fila: não reaparece sozinho na volta', () => {
    seedCrewChild()
    render(<AttentionHud />)
    pin()
    expect(screen.getByTestId('attention-hud-popover')).toBeInTheDocument()
    act(() => seedCrewChild('working'))
    expect(screen.queryByTestId('attention-hud-popover')).toBeNull()
    act(() => seedCrewChild('waiting'))
    expect(screen.queryByTestId('attention-hud-popover')).toBeNull()
  })

  it('fecha quando o usuário sai do alvo (peek fechado / outra sessão)', () => {
    seedCrewChild()
    render(<AttentionHud />)
    pin()
    expect(screen.getByTestId('attention-hud-popover')).toBeInTheDocument()
    act(() => useCrewDockStore.setState({ peekId: null }))
    expect(screen.queryByTestId('attention-hud-popover')).toBeNull()
  })

  it('fecha quando um overlay bloqueante toma o foco', () => {
    seedCrewChild()
    render(<AttentionHud />)
    pin()
    const modal = document.createElement('div')
    modal.setAttribute('data-modal-overlay', '')
    const input = document.createElement('input')
    modal.appendChild(input)
    document.body.appendChild(modal)
    act(() => input.focus())
    expect(screen.queryByTestId('attention-hud-popover')).toBeNull()
    modal.remove()
  })

  // Dois popovers da mesma sessão = duas respostas pro mesmo menu (ou a 2ª caindo
  // no prompt seguinte, que o usuário não viu): só um vive por sessão.
  it('uma instância por sessão: expandir na lista fecha o fixado, e fixar recolhe a lista', () => {
    seedCrewChild()
    render(
      <>
        <AttentionHud />
        <AttentionQueueButton queue={[permissionItem]} />
      </>,
    )
    pin()
    expect(screen.getByTestId('attention-hud-popover')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('titlebar-attention-list'))
    fireEvent.click(screen.getByTestId('attention-queue-item'))
    expect(screen.queryByTestId('attention-hud-popover')).toBeNull()
    expect(screen.getAllByTestId('attention-popover')).toHaveLength(1)

    act(() =>
      useAttentionStore.setState({
        flash: { nonce: 2, position: 1, total: 1, item: permissionItem },
      }),
    )
    expect(screen.getByTestId('attention-hud-popover')).toBeInTheDocument()
    expect(screen.getByTestId('attention-queue-item')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getAllByTestId('attention-popover')).toHaveLength(1)
  })
})

describe('AttentionHud', () => {
  it('live region nasce vazia, escondida da árvore de acessibilidade', () => {
    render(<AttentionHud />)
    const hud = screen.getByTestId('attention-hud')
    expect(hud).toHaveAttribute('role', 'status')
    expect(hud).toBeEmptyDOMElement()
    expect(hud).toHaveAttribute('aria-hidden', 'true')
  })

  it('preenche e expõe no pulo, e volta a aria-hidden quando some', () => {
    vi.useFakeTimers()
    render(<AttentionHud />)
    act(() => useAttentionStore.setState({ flash: { nonce: 1, position: 3, total: 3, item } }))
    const hud = screen.getByTestId('attention-hud')
    expect(hud).not.toHaveAttribute('aria-hidden')
    expect(hud).toHaveTextContent('3/3 · proj · Auth · pergunta pendente')
    act(() => vi.advanceTimersByTime(1300))
    expect(hud).toHaveAttribute('aria-hidden', 'true')
    expect(hud).toHaveAttribute('data-visible', 'false')
  })
})
