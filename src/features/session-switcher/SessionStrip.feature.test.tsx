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
}))

const sessions: LiveSessionInfo[] = []
const openSession = vi.fn()
vi.mock('./useGlobalSessions', () => ({
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
