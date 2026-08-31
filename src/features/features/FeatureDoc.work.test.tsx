import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Feature, Project, Repo } from '../../../shared/types/ipc'

vi.mock('./FeatureTasksSection', () => ({ FeatureTasksSection: () => null }))
vi.mock('./FeatureObjectiveLinksSection', () => ({ FeatureObjectiveLinksSection: () => null }))
vi.mock('./FeatureSessions', () => ({ FeatureSessions: () => null }))
vi.mock('./useObjectiveLookups', () => ({
  useObjectiveLookups: () => ({ objectives: [], krTitles: new Map(), krObjectiveId: new Map() }),
}))

// O diálogo real tem cobertura própria (SpawnSessionDialog.feature.test.tsx);
// aqui só interessa COM QUE repo/feature o dossiê o abre.
vi.mock('@/features/sessions/SpawnSessionDialog', () => ({
  SpawnSessionDialog: ({ repo, initialFeatureId }: { repo: Repo; initialFeatureId?: string }) => (
    <div data-testid="spawn-dialog" data-repo={repo.id} data-feature={initialFeatureId} />
  ),
}))

vi.mock('@/lib/ipc', () => ({
  shellApi: { openPath: vi.fn() },
  sessionsApi: {},
  prefsApi: { get: vi.fn().mockResolvedValue(null), set: vi.fn() },
  loopApi: {
    snapshot: vi.fn().mockResolvedValue(null),
    setPulse: vi.fn(),
    pulseHistory: vi.fn().mockResolvedValue([]),
    onUpdated: vi.fn(() => () => {}),
  },
}))

const { FeatureDoc } = await import('./FeatureDoc')

function makeRepo(id: string, label: string): Repo {
  return {
    id,
    projectId: 'p1',
    label,
    path: `/repos/${id}`,
    role: null,
    linkKind: 'local',
    source: null,
    position: 0,
    createdAt: 0,
    canvasX: null,
    canvasY: null,
    isHub: false,
  }
}

const repoA = makeRepo('r1', 'legal-core')
const repoB = makeRepo('r2', 'legal-ui')
const project = { id: 'p1', name: 'pitwall', icon: null, color: null } as Project

function makeFeature(repoIds: string[]): Feature {
  return {
    id: 'f1',
    projectId: 'p1',
    slug: 'trf4',
    title: 'Extração TRF4',
    status: 'in-progress',
    objective: null,
    docPath: '/tmp/f1.md',
    synthMode: 'auto',
    model: null,
    repos: repoIds.map((repoId) => ({ featureId: 'f1', repoId, branch: null })),
    origin: 'manual',
    objectiveLinkCount: 0,
    isAppDev: false,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    archivedAt: null,
    body: '# Doc',
  }
}

function renderDoc(repoIds: string[], repos: Repo[] = [repoA, repoB]) {
  render(
    <FeatureDoc
      feature={makeFeature(repoIds)}
      loading={false}
      reposById={new Map(repos.map((r) => [r.id, r]))}
      projectsById={new Map([[project.id, project]])}
    />,
  )
}

describe('FeatureDoc — trabalhar nesta feature', () => {
  it('com um repo vinculado, abre o diálogo já com feature e repo', () => {
    renderDoc(['r1'])
    fireEvent.click(screen.getByTestId('feature-work-button'))
    const dialog = screen.getByTestId('spawn-dialog')
    expect(dialog).toHaveAttribute('data-repo', 'r1')
    expect(dialog).toHaveAttribute('data-feature', 'f1')
  })

  it('com vários repos, pergunta em qual antes de abrir', () => {
    renderDoc(['r1', 'r2'])
    fireEvent.click(screen.getByTestId('feature-work-button'))
    expect(screen.queryByTestId('spawn-dialog')).not.toBeInTheDocument()

    // O label também aparece no chip de repo do header: aqui é o item do menu.
    fireEvent.click(screen.getByRole('button', { name: 'legal-ui' }))
    expect(screen.getByTestId('spawn-dialog')).toHaveAttribute('data-repo', 'r2')
  })

  it('o atalho global dispara o mesmo gesto da feature em foco', () => {
    renderDoc(['r1'])
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, shiftKey: true })
    expect(screen.getByTestId('spawn-dialog')).toHaveAttribute('data-feature', 'f1')
  })

  it('sem repo vinculado, o botão explica em vez de não fazer nada', () => {
    renderDoc([])
    fireEvent.click(screen.getByTestId('feature-work-button'))
    expect(screen.queryByTestId('spawn-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('feature-work-no-repo')).toHaveTextContent(
      /não tem repo vinculado/i,
    )
  })
})
