import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionInfo } from '../../../shared/types/ipc'

const navigateToFeature = vi.fn()
vi.mock('@/lib/nav', () => ({
  navigateToFeature: (id: string) => navigateToFeature(id),
  navigateToObjective: vi.fn(),
  navigateToTask: vi.fn(),
  navigateToProject: vi.fn(),
  navigateToDiagram: vi.fn(),
}))
vi.mock('@/lib/ipc', () => ({
  featuresApi: { get: vi.fn(), listWithStats: vi.fn().mockResolvedValue([]) },
  sessionsApi: { listByFeature: vi.fn().mockResolvedValue([]) },
  prefsApi: { get: vi.fn().mockResolvedValue(null), set: vi.fn() },
  sessionGraphApi: { onUpdated: () => () => {}, get: () => new Promise(() => {}) },
  motherPinsApi: {
    list: () => Promise.resolve([]),
    onUpdated: () => () => {},
    onRestart: () => () => {},
  },
}))

const sessions: LiveSessionInfo[] = []
// Vivas sem aba (filhas no dock): estão no snapshot do store, fora das visíveis.
const background: LiveSessionInfo[] = []
const openSession = vi.fn()
vi.mock('./useGlobalSessions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useVisibleLiveSessions: () => sessions,
  useEndedSessions: () => null,
}))
vi.mock('./useWaitingCount', () => ({ useWaitingCount: () => 0 }))
// Pins têm persistência própria (prefs assíncronas) e nada a ver com a marca.
vi.mock('./strip-pins-store', () => ({
  useStripPinsStore: (sel: (s: unknown) => unknown) =>
    sel({
      pinnedIds: [],
      loaded: true,
      load: vi.fn().mockResolvedValue(undefined),
      togglePin: vi.fn(),
      prune: vi.fn().mockResolvedValue(undefined),
    }),
}))
vi.mock('@/store/appStore', () => ({
  pendingEndSessionIds: () => new Set<string>(),
  useAppStore: (sel: (s: unknown) => unknown) =>
    sel({
      liveSessions: background.length > 0 ? [...sessions, ...background] : sessions,
      panes: [],
      focusPaneId: vi.fn(),
      focusOrOpenSession: openSession,
      endSession: vi.fn(),
    }),
}))

const { SessionStrip } = await import('./SessionStrip')
const { useSessionFeatureStore } = await import('@/store/sessionFeatureStore')
const { useSessionGraphStore } = await import('@/features/sessions/session-graph-store')
const { useMotherPinsStore } = await import('@/features/sessions/mother-pins-store')
const { useFocusFilterStore } = await import('@/lib/focus-filter-store')

function makeSession(over: Partial<LiveSessionInfo> = {}): LiveSessionInfo {
  return {
    id: 's-1',
    ccSessionId: 'cc-1',
    name: 'sessão viva',
    title: null,
    status: 'idle',
    lastActivityAt: Date.now(),
    repo: { id: 'r1', label: 'claude-manager', path: '/repo' },
    projectName: 'pitwall',
    projectIcon: null,
    projectColor: null,
    ...over,
  } as LiveSessionInfo
}

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

beforeEach(() => {
  navigateToFeature.mockClear()
  openSession.mockClear()
  sessions.length = 0
  background.length = 0
  useSessionFeatureStore.setState({
    bySessionId: { 's-1': 'f-42' },
    featureTitles: { 'f-42': 'Extração TRF4' },
    hydrated: true,
    hydrate: vi.fn().mockResolvedValue(undefined),
  })
})

describe('SessionStrip — marca da feature', () => {
  it('mostra a marca da sessão vinculada e navega sem focar a sessão', () => {
    sessions.push(makeSession())
    render(<SessionStrip onOpenSwitcher={() => {}} />)

    const chip = screen.getByTestId('session-feature-chip')
    fireEvent.mouseDown(chip)
    fireEvent.click(chip)

    expect(navigateToFeature).toHaveBeenCalledWith('f-42')
    expect(openSession).not.toHaveBeenCalled()
  })

  it('sessão sem feature não ganha marca', () => {
    sessions.push(makeSession({ id: 's-solta' }))
    render(<SessionStrip onOpenSwitcher={() => {}} />)
    expect(screen.queryByTestId('session-feature-chip')).not.toBeInTheDocument()
  })
})

function node(sessionId: string, over: Record<string, unknown> = {}) {
  return { sessionId, ccSessionId: `cc-${sessionId}`, hierarchyMotherId: null, ...over }
}

describe('SessionStrip — mães e filhas', () => {
  it('filha logo depois da mãe, recuada; mãe marcada abre a seção "Mães"', () => {
    sessions.push(
      makeSession({ id: 'filha', ccSessionId: 'cc-filha', name: 'filha' }),
      makeSession({ id: 'outra', ccSessionId: 'cc-outra', name: 'outra' }),
      makeSession({ id: 'mae', ccSessionId: 'cc-mae', name: 'mae' }),
    )
    useSessionGraphStore.setState({
      graph: {
        nodes: [node('mae'), node('outra'), node('filha', { hierarchyMotherId: 'mae' })] as never,
        lanes: [],
        edges: [],
      },
    })
    useMotherPinsStore.setState({ keys: ['cc-mae'], loaded: true })
    // Todas as sessões: com o filtro "Mães + quem precisa de mim" a filha quieta sai.
    useFocusFilterStore.setState({ enabled: false, loaded: true, load: async () => {} } as never)
    render(<SessionStrip onOpenSwitcher={() => {}} />)
    const chips = [...document.querySelectorAll<HTMLElement>('[data-strip-chip]')]
    expect(chips.map((c) => c.textContent?.match(/mae|filha|outra/)?.[0])).toEqual([
      'mae',
      'filha',
      'outra',
    ])
    expect(chips[1].dataset.depth).toBe('1')
    expect(chips[0].dataset.pinnedMother).toBe('true')
    expect(screen.getByTestId('strip-mothers-section')).toHaveTextContent('Mães')
  })
})

describe('SessionStrip — filhas em segundo plano', () => {
  const named = (id: string, over: Partial<LiveSessionInfo> = {}) =>
    makeSession({ id, ccSessionId: `cc-${id}`, name: id, ...over })

  function setup(nodes: ReturnType<typeof node>[], focusOnly: boolean) {
    useSessionGraphStore.setState({ graph: { nodes: nodes as never, lanes: [], edges: [] } })
    useMotherPinsStore.setState({ keys: [], loaded: true })
    useFocusFilterStore.setState({
      enabled: focusOnly,
      loaded: true,
      load: async () => {},
    } as never)
    render(<SessionStrip onOpenSwitcher={() => {}} />)
  }
  const barOrder = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-strip-chip], [data-testid="strip-background-children"]',
      ),
    ].map((c) => c.textContent?.match(/mae|outra|com-aba|2º plano/)?.[0])

  it('chip agregado logo depois da mãe; o item do menu abre a aba da filha', () => {
    sessions.push(named('mae'), named('outra'))
    background.push(named('helena-auth', { status: 'waiting' }))
    setup([node('mae'), node('outra'), node('helena-auth', { hierarchyMotherId: 'mae' })], false)

    const chip = screen.getByTestId('strip-background-children')
    expect(chip).toHaveTextContent('↳ 1 em 2º plano')
    expect(chip.dataset.waiting).toBe('true')
    expect(barOrder()).toEqual(['mae', '2º plano', 'outra'])

    fireEvent.click(chip)
    fireEvent.click(screen.getByText('helena-auth · aguardando você'))
    expect(openSession).toHaveBeenCalledWith(background[0])
  })

  it('filtro de foco ligado: o chip conta só as sem aba, o "+N" só as com aba', () => {
    sessions.push(named('mae'), named('com-aba'))
    background.push(named('helena-auth'))
    setup(
      [
        node('mae'),
        node('com-aba', { hierarchyMotherId: 'mae' }),
        node('helena-auth', { hierarchyMotherId: 'mae' }),
      ],
      true,
    )

    expect(barOrder()).toEqual(['mae', '2º plano'])
    const chip = screen.getByTestId('strip-background-children')
    expect(chip).toHaveTextContent('↳ 1 em 2º plano')
    expect(chip.dataset.waiting).toBeUndefined()
    expect(screen.getByTestId('session-strip-focus-toggle')).toHaveTextContent('+1')
  })

  it('mãe fora da barra: o grupo fica no fim, mesmo sem nenhuma aba', () => {
    background.push(named('helena-auth'))
    setup([node('helena-auth', { hierarchyMotherId: 'mae' })], false)

    expect(screen.getByTestId('strip-background-children')).toHaveTextContent('↳ 1 em 2º plano')
    expect(screen.queryByText(/Nenhuma sessão viva/)).not.toBeInTheDocument()
  })

  it('sem filha em segundo plano não há chip', () => {
    sessions.push(named('mae'))
    setup([node('mae')], false)
    expect(screen.queryByTestId('strip-background-children')).not.toBeInTheDocument()
  })
})
