import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAttentionListStore } from '@/store/attentionStore'
import type { AttentionItem } from '../../../shared/types/attention'
import type { Feature } from '../../../shared/types/ipc'
import type { SessionGraphNode } from '../../../shared/types/session-graph'

const BODY = `
## Visão geral

Checkout.

## Regras de negócio

- Desconto máx 10%

## Notas fixadas

Primeira nota
com duas linhas

---

Segunda nota

---

Terceira nota

## Decisões

- Stripe, pelo PIX.
`

function feature(body = BODY): Feature {
  return {
    id: 'f1',
    projectId: 'p1',
    slug: 'checkout',
    title: 'Checkout',
    status: 'in-progress',
    objective: null,
    docPath: '/tmp/checkout.md',
    synthMode: 'auto',
    model: null,
    repos: [],
    origin: 'manual',
    objectiveLinkCount: 0,
    isAppDev: false,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    archivedAt: null,
    body,
  } as Feature
}

vi.mock('@/lib/ipc', () => ({
  featuresApi: {
    get: vi.fn(),
    updateSection: vi.fn(),
    onUpdated: vi.fn(() => () => {}),
  },
  loopApi: {
    snapshot: vi.fn().mockResolvedValue({
      featureId: 'f1',
      pulse: null,
      liveness: 'alive',
      issues: [],
      ledger: [
        {
          featureId: 'f1',
          entryId: 'd1',
          kind: 'decision',
          title: 'Sem boleto',
          body: null,
          createdAt: 0,
          updatedAt: 0,
          archivedAt: null,
        },
        {
          featureId: 'f1',
          entryId: 'x1',
          kind: 'change',
          title: 'Mudança comum',
          body: null,
          createdAt: 0,
          updatedAt: 0,
          archivedAt: null,
        },
      ],
      metrics: [],
      lastActivityAt: 0,
      pinned: false,
      focusRank: null,
    }),
    onUpdated: vi.fn(() => () => {}),
    pulseHistory: vi.fn().mockResolvedValue([]),
  },
  projectsApi: { list: vi.fn().mockResolvedValue([]), listRepos: vi.fn().mockResolvedValue([]) },
  sessionsApi: { listByFeature: vi.fn().mockResolvedValue([]) },
}))

const { FeaturePanel, FeatureCardReminders } = await import('./FeaturePanel')
const { useFeaturePanelStore } = await import('./feature-panel-store')
const { featuresApi } = await import('@/lib/ipc')
const getMock = featuresApi.get as unknown as ReturnType<typeof vi.fn>
const updateMock = featuresApi.updateSection as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  useAttentionListStore.setState({ items: [] })
  getMock.mockResolvedValue(feature())
  updateMock.mockImplementation(async ({ markdown }: { markdown: string }) =>
    feature(BODY.replace('- Desconto máx 10%', markdown)),
  )
  useFeaturePanelStore.getState().close()
})

describe('FeatureCardReminders', () => {
  it('as 2 primeiras notas fixadas, em 1 linha cada com o texto inteiro no title', async () => {
    render(<FeatureCardReminders featureId="f1" zoom={1} placement="line" />)
    const items = await screen.findAllByTestId('feature-card-reminder')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Primeira nota')
    expect(items[1]).toHaveTextContent('Segunda nota')
    // Reticências no corte: line-clamp (display -webkit-box) anulava o ellipsis
    // do truncate e o texto era cortado no meio da palavra.
    const text = items[0].querySelector('.truncate')!
    expect(text).not.toBeNull()
    expect(text.className).not.toContain('line-clamp')
    expect(items[0].getAttribute('title')).toContain('Primeira nota')
    // Tom neutro: o laranja (warning) é do status, nos lembretes só no glifo.
    expect(items[0].className).not.toContain('warning')
    // 3ª nota + 1 regra de negócio → "+2 regras", que abre Notas & regras.
    const more = screen.getByTestId('feature-card-reminders-more')
    expect(more).toHaveTextContent('+2 regras')
    fireEvent.click(more)
    expect(useFeaturePanelStore.getState()).toMatchObject({ openFeatureId: 'f1', tab: 'notes' })
  })
  it('abaixo do zoom base: só o chip "N lembretes" (tooltip com todos), sem a linha', async () => {
    render(
      <>
        <FeatureCardReminders featureId="f1" zoom={0.8} placement="chip" />
        <FeatureCardReminders featureId="f1" zoom={0.8} placement="line" />
      </>,
    )
    const chip = await screen.findByTestId('feature-card-reminders-chip')
    expect(chip).toHaveTextContent('4 lembretes')
    expect(chip.getAttribute('title')).toContain('Primeira nota')
    expect(chip.getAttribute('title')).toContain('Segunda nota')
    expect(screen.queryByTestId('feature-card-reminders')).toBeNull()
  })
})

describe('FeaturePanel', () => {
  it('fechado não renderiza nada', () => {
    render(<FeaturePanel />)
    expect(screen.queryByTestId('feature-panel')).toBeNull()
  })

  it('regras de negócio: edita inline e salva sozinho ~600ms depois de parar de digitar', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    act(() => useFeaturePanelStore.getState().open('f1'))
    render(<FeaturePanel />)
    await screen.findByText('Checkout')
    fireEvent.click(screen.getByTestId('feature-panel-tab-notes'))
    fireEvent.click(await screen.findByTestId('feature-panel-rules-view'))
    const input = screen.getByTestId('feature-panel-rules-input')
    fireEvent.change(input, { target: { value: '- Desconto máx 5%' } })
    expect(updateMock).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(650)
    })
    expect(updateMock).toHaveBeenCalledWith({
      featureId: 'f1',
      section: 'Regras de negócio',
      markdown: '- Desconto máx 5%',
    })
    await waitFor(() =>
      expect(screen.getByTestId('feature-panel-rules-status')).toHaveAttribute(
        'data-state',
        'saved',
      ),
    )
    vi.useRealTimers()
  })

  it('save que falha no blur não devolve o texto antigo; o próximo blur tenta de novo', async () => {
    updateMock.mockRejectedValueOnce(new Error('disco cheio'))
    act(() => useFeaturePanelStore.getState().open('f1'))
    render(<FeaturePanel />)
    await screen.findByText('Checkout')
    fireEvent.click(screen.getByTestId('feature-panel-tab-notes'))
    fireEvent.click(await screen.findByTestId('feature-panel-rules-view'))
    const input = screen.getByTestId('feature-panel-rules-input')
    fireEvent.change(input, { target: { value: '- Desconto máx 1%' } })
    fireEvent.blur(input)
    await waitFor(() =>
      expect(screen.getByTestId('feature-panel-rules-status')).toHaveAttribute('data-state', 'error'),
    )
    expect(screen.getByTestId('feature-panel-rules-view')).toHaveTextContent('Desconto máx 1%')
    fireEvent.click(screen.getByTestId('feature-panel-rules-view'))
    fireEvent.blur(screen.getByTestId('feature-panel-rules-input'))
    await waitFor(() =>
      expect(screen.getByTestId('feature-panel-rules-status')).toHaveAttribute('data-state', 'saved'),
    )
    expect(updateMock).toHaveBeenCalledTimes(2)
    expect(updateMock.mock.calls[1][0].markdown).toBe('- Desconto máx 1%')
  })

  it('com a Equipe aberta, o painel abre à esquerda dela (não fica coberto)', async () => {
    act(() => useFeaturePanelStore.getState().open('f1'))
    render(<FeaturePanel rightInset={340} />)
    expect((await screen.findByTestId('feature-panel')).style.right).toBe('340px')
  })

  it('Esc com o foco numa aba fecha o painel; atalho global com Ctrl chega à janela', async () => {
    act(() => useFeaturePanelStore.getState().open('f1'))
    render(<FeaturePanel />)
    const tab = screen.getByTestId('feature-panel-tab-decisions')
    const heard: string[] = []
    const onKey = (e: KeyboardEvent) => heard.push(e.key)
    window.addEventListener('keydown', onKey)
    fireEvent.keyDown(tab, { key: 't', ctrlKey: true })
    fireEvent.keyDown(tab, { key: 'Delete' })
    expect(heard).toEqual(['t'])
    fireEvent.keyDown(tab, { key: 'Escape' })
    window.removeEventListener('keydown', onKey)
    expect(useFeaturePanelStore.getState().openFeatureId).toBeNull()
  })

  it('Esc com Dialog ou menu de contexto por cima fecha só a camada de cima, não o painel', async () => {
    act(() => useFeaturePanelStore.getState().open('f1'))
    render(<FeaturePanel />)
    await screen.findByTestId('feature-panel')
    for (const attrs of [{ 'data-modal-overlay': '' }, { role: 'menu' }]) {
      const layer = document.createElement('div')
      for (const [k, v] of Object.entries(attrs)) layer.setAttribute(k, v)
      document.body.appendChild(layer)
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(useFeaturePanelStore.getState().openFeatureId).toBe('f1')
      layer.remove()
    }
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useFeaturePanelStore.getState().openFeatureId).toBeNull()
  })

  it('fechar o painel no meio da digitação não perde o texto', async () => {
    act(() => useFeaturePanelStore.getState().open('f1'))
    render(<FeaturePanel />)
    await screen.findByText('Checkout')
    fireEvent.click(screen.getByTestId('feature-panel-tab-notes'))
    fireEvent.click(await screen.findByTestId('feature-panel-notes-view'))
    fireEvent.change(screen.getByTestId('feature-panel-notes-input'), {
      target: { value: 'nota nova' },
    })
    act(() => useFeaturePanelStore.getState().close())
    expect(updateMock).toHaveBeenCalledWith({
      featureId: 'f1',
      section: 'Notas fixadas',
      markdown: 'nota nova',
    })
  })

  it('decisões: a seção do doc mais só o ledger kind=decision', async () => {
    act(() => useFeaturePanelStore.getState().open('f1'))
    render(<FeaturePanel />)
    await screen.findByText('Checkout')
    fireEvent.click(screen.getByTestId('feature-panel-tab-decisions'))
    expect(await screen.findByText('Sem boleto')).toBeInTheDocument()
    expect(screen.getByText(/Stripe, pelo PIX/)).toBeInTheDocument()
    expect(screen.queryByText('Mudança comum')).toBeNull()
  })

  it('abre em "Estado" com dados: sessões por estado, regras fixadas e a última mudança', async () => {
    act(() => useFeaturePanelStore.getState().open('f1'))
    const sessions = [
      { sessionId: 'a', title: 'a', featureId: 'f1', status: 'working', attentionReason: null },
      { sessionId: 'b', title: 'b', featureId: 'f1', status: 'idle', attentionReason: 'handoff-input' },
      { sessionId: 'c', title: 'c', featureId: 'f2', status: 'working', attentionReason: null },
    ] as unknown as SessionGraphNode[]
    // O 'precisam de você' é o recorte da fila única (a mesma que deu o attentionReason de b).
    useAttentionListStore.setState({
      items: [
        { kind: 'child_question', severity: 'blocking', sessionId: 'b', handoffId: 'h', featureId: 'f1', dedupKey: 'q:h' },
      ] as unknown as AttentionItem[],
    })
    render(<FeaturePanel sessions={sessions} />)
    await screen.findByText('Checkout')
    expect(screen.getByTestId('feature-panel-tab-state')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('tab')).toHaveLength(4)
    const counts = await screen.findByTestId('feature-panel-state-counts')
    expect(counts).toHaveTextContent('1precisam de você')
    expect(counts).toHaveTextContent('1trabalhando')
    expect(screen.getByTestId('feature-panel-state-rules').querySelectorAll('li')).toHaveLength(3)
    expect(screen.getByTestId('feature-panel-state-ledger')).toBeInTheDocument()
    // O texto explicativo saiu do corpo (fica no (i)).
    expect(screen.queryByText(/Esta seção é escrita pela síntese/)).toBeNull()
  })

  it('Estado mostra a mãe com as filhas e o bastão, e a lista das sessões com status', async () => {
    act(() => useFeaturePanelStore.getState().open('f1'))
    const base = { featureId: 'f1', attentionReason: null, provider: 'claude', childOfHandoffId: null }
    const sessions = [
      { ...base, sessionId: 'm', title: 'mae-checkout', status: 'working', isMother: true, childCount: 2, ccSessionId: 'cc-m' },
      { ...base, sessionId: 'o', title: 'otavio', status: 'waiting', attentionReason: 'waiting', childOfHandoffId: 'h1' },
      { ...base, sessionId: 'r', title: 'marina', status: 'idle', childOfHandoffId: 'h2' },
    ] as unknown as SessionGraphNode[]
    const actions = { open: vi.fn(), passBaton: vi.fn(), canPassBaton: () => true }
    render(<FeaturePanel sessions={sessions} actions={actions} />)
    const mother = await screen.findByTestId('feature-panel-mother')
    expect(mother).toHaveTextContent('mae-checkout')
    expect(mother).toHaveTextContent('2 filhas')
    fireEvent.click(screen.getByTestId('feature-panel-mother-baton'))
    expect(actions.passBaton).toHaveBeenCalledWith(sessions[0])
    fireEvent.click(screen.getByTestId('feature-panel-mother-open'))
    expect(actions.open).toHaveBeenCalledWith(sessions[0])
    const rows = screen.getByTestId('feature-panel-crew').querySelectorAll('li')
    expect([...rows].map((r) => r.textContent)).toEqual([
      'mae-checkouttrabalhando',
      '↳otavioprecisa de você',
      '↳marinaparada',
    ])
  })

  it('um status só: o badge do card no cabeçalho; a vitalidade vira ponto ao lado de PULSO', async () => {
    act(() => useFeaturePanelStore.getState().open('f1'))
    render(<FeaturePanel />)
    await screen.findByText('Checkout')
    expect(screen.getByTestId('feature-panel-status')).toHaveTextContent('em andamento')
    const dot = await screen.findByTestId('liveness-chip')
    expect(dot.closest('h3')).toHaveTextContent(/Pulso/)
  })
})
