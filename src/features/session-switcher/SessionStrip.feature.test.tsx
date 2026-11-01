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
      liveSessions: sessions,
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

describe('SessionStrip — mães e filhas', () => {
  function node(sessionId: string, over: Record<string, unknown> = {}) {
    return { sessionId, ccSessionId: `cc-${sessionId}`, hierarchyMotherId: null, ...over }
  }

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

