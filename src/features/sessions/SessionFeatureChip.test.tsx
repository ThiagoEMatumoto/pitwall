import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigateToFeature = vi.fn()
vi.mock('@/lib/nav', () => ({
  navigateToFeature: (id: string) => navigateToFeature(id),
  navigateToObjective: vi.fn(),
  navigateToTask: vi.fn(),
  navigateToProject: vi.fn(),
  navigateToDiagram: vi.fn(),
}))

const hydrate = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/ipc', () => ({
  featuresApi: { get: vi.fn(), listWithStats: vi.fn().mockResolvedValue([]) },
  sessionsApi: { listByFeature: vi.fn().mockResolvedValue([]) },
}))

const { SessionFeatureChip } = await import('./SessionFeatureChip')
const { useSessionFeatureStore } = await import('@/store/sessionFeatureStore')

beforeEach(() => {
  navigateToFeature.mockClear()
  hydrate.mockClear()
  useSessionFeatureStore.setState({
    bySessionId: { 's-1': 'f-42' },
    featureTitles: { 'f-42': 'Extração TRF4' },
    hydrated: true,
    hydrate,
  })
})

describe('SessionFeatureChip', () => {
  it('não renderiza nada quando a sessão não tem feature', () => {
    const { container } = render(<SessionFeatureChip sessionId="s-sem-feature" density="chip" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('não renderiza nada sem sessionId', () => {
    const { container } = render(<SessionFeatureChip sessionId={null} density="dot" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('não renderiza enquanto o título da feature não chegou', () => {
    useSessionFeatureStore.setState({ featureTitles: {} })
    const { container } = render(<SessionFeatureChip sessionId="s-1" density="chip" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('mostra o título da feature na densidade chip', () => {
    render(<SessionFeatureChip sessionId="s-1" density="chip" />)
    expect(screen.getByTestId('session-feature-chip')).toHaveTextContent('Extração TRF4')
  })

  it('esconde o título na densidade dot, mantendo-o no tooltip', () => {
    render(<SessionFeatureChip sessionId="s-1" density="dot" />)
    const chip = screen.getByTestId('session-feature-chip')
    expect(chip).not.toHaveTextContent('Extração TRF4')
    expect(chip).toHaveAttribute('title', 'Voltar para a feature: Extração TRF4')
  })

  it('aceita featureId explícito quando a sessão não está no índice', () => {
    render(<SessionFeatureChip sessionId="s-fora" density="chip" featureId="f-42" />)
    expect(screen.getByTestId('session-feature-chip')).toHaveTextContent('Extração TRF4')
  })

  it('navega pra feature no clique', () => {
    render(<SessionFeatureChip sessionId="s-1" density="chip" />)
    fireEvent.click(screen.getByTestId('session-feature-chip'))
    expect(navigateToFeature).toHaveBeenCalledWith('f-42')
  })

  it('navega pelo teclado (Enter)', () => {
    render(<SessionFeatureChip sessionId="s-1" density="chip" />)
    fireEvent.keyDown(screen.getByTestId('session-feature-chip'), { key: 'Enter' })
    expect(navigateToFeature).toHaveBeenCalledWith('f-42')
  })

  it('não propaga o clique nem o mousedown pro container (linha/aba)', () => {
    const onContainerClick = vi.fn()
    const onContainerMouseDown = vi.fn()
    render(
      <div onClick={onContainerClick} onMouseDown={onContainerMouseDown}>
        <SessionFeatureChip sessionId="s-1" density="dot" />
      </div>,
    )
    const chip = screen.getByTestId('session-feature-chip')
    fireEvent.mouseDown(chip)
    fireEvent.click(chip)
    expect(navigateToFeature).toHaveBeenCalledWith('f-42')
    expect(onContainerClick).not.toHaveBeenCalled()
    expect(onContainerMouseDown).not.toHaveBeenCalled()
  })

  it('barra listener NATIVO de ancestral (aba do dockview)', () => {
    const nativeParent = vi.fn()
    const { container } = render(
      <div data-testid="tab">
        <SessionFeatureChip sessionId="s-1" density="dot" />
      </div>,
    )
    const tab = container.querySelector('[data-testid="tab"]')!
    tab.addEventListener('mousedown', nativeParent)
    tab.addEventListener('click', nativeParent)
    fireEvent.mouseDown(screen.getByTestId('session-feature-chip'))
    fireEvent.click(screen.getByTestId('session-feature-chip'))
    expect(nativeParent).not.toHaveBeenCalled()
  })

  it('dispara hydrate ao montar', () => {
    render(<SessionFeatureChip sessionId="s-1" density="chip" />)
    expect(hydrate).toHaveBeenCalled()
  })

  // Regressao: com o featureId vindo pronto por prop (SessionsModal), o span so
  // nasce quando o TITULO chega. Se o efeito dos listeners nao depender de
  // `title`, ele roda uma vez so - com ref.current ainda null - e o chip fica
  // inerte ao clique (o teclado seguia funcionando, mascarando a falha).
  it('liga o clique quando o titulo chega depois do featureId', async () => {
    useSessionFeatureStore.setState({ bySessionId: {}, featureTitles: {} })
    render(<SessionFeatureChip sessionId="s-9" featureId="f-42" density="chip" />)
    expect(screen.queryByTestId('session-feature-chip')).toBeNull()
    await act(async () => {
      useSessionFeatureStore.setState({ featureTitles: { 'f-42': 'Extração TRF4' } })
    })
    fireEvent.click(screen.getByTestId('session-feature-chip'))
    expect(navigateToFeature).toHaveBeenCalledWith('f-42')
  })
})
