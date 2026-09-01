import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, SessionSummary } from '../../../shared/types/ipc'

// O diálogo de spawn tem IPC/prefs próprios e não é o alvo aqui.
vi.mock('./SpawnSessionDialog', () => ({ SpawnSessionDialog: () => null }))
vi.mock('@/lib/nav', () => ({
  navigateToFeature: vi.fn(),
  navigateToObjective: vi.fn(),
  navigateToTask: vi.fn(),
  navigateToProject: vi.fn(),
  navigateToDiagram: vi.fn(),
}))
vi.mock('@/store/appStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel({ openSession: vi.fn(), resumeSession: vi.fn() }),
}))

const listByRepo = vi.fn()
vi.mock('@/lib/ipc', () => ({
  sessionsApi: { listByRepo: (id: string) => listByRepo(id), listByFeature: vi.fn() },
  featuresApi: { get: vi.fn(), listWithStats: vi.fn().mockResolvedValue([]) },
}))

const { SessionsModal } = await import('./SessionsModal')
const { useSessionFeatureStore } = await import('@/store/sessionFeatureStore')

const repo: Repo = {
  id: 'r1',
  projectId: 'p1',
  label: 'claude-manager',
  path: '/repo',
  role: null,
  linkKind: 'local',
  source: null,
} as Repo

function makeSummary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's-1',
    ccSessionId: 'cc-1',
    featureId: null,
    name: 'sessão antiga',
    title: null,
    status: 'ended',
    lastActivityAt: Date.now(),
    isLive: false,
    ...over,
  }
}

beforeEach(() => {
  useSessionFeatureStore.setState({
    bySessionId: {},
    featureTitles: { 'f-42': 'Extração TRF4' },
    hydrated: true,
    hydrate: vi.fn().mockResolvedValue(undefined),
  })
})

describe('SessionsModal — marca da feature', () => {
  it('mostra o chip da feature que veio no SessionSummary', async () => {
    listByRepo.mockResolvedValue([makeSummary({ featureId: 'f-42' })])
    render(
      <SessionsModal
        repo={repo}
        projectName="pitwall"
        projectIcon={null}
        projectColor={null}
        open
        onClose={() => {}}
      />,
    )
    expect(await screen.findByTestId('session-feature-chip')).toHaveTextContent('Extração TRF4')
  })

  it('resolve pelo índice reverso quando o summary não traz o vínculo', async () => {
    useSessionFeatureStore.setState({ bySessionId: { 's-1': 'f-42' } })
    listByRepo.mockResolvedValue([makeSummary()])
    render(
      <SessionsModal
        repo={repo}
        projectName="pitwall"
        projectIcon={null}
        projectColor={null}
        open
        onClose={() => {}}
      />,
    )
    expect(await screen.findByTestId('session-feature-chip')).toHaveTextContent('Extração TRF4')
  })

  it('sessão sem feature não ganha marca nenhuma', async () => {
    listByRepo.mockResolvedValue([makeSummary()])
    render(
      <SessionsModal
        repo={repo}
        projectName="pitwall"
        projectIcon={null}
        projectColor={null}
        open
        onClose={() => {}}
      />,
    )
    expect(await screen.findByText('sessão antiga')).toBeInTheDocument()
    expect(screen.queryByTestId('session-feature-chip')).not.toBeInTheDocument()
  })
})
