import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type {
  FeatureSessionSummary,
  LiveSessionInfo,
  Project,
  Repo,
} from '../../../shared/types/ipc'

const listByFeature = vi.fn()
vi.mock('@/lib/ipc', () => ({
  sessionsApi: { listByFeature: (id: string) => listByFeature(id) },
  featuresApi: { get: vi.fn(), listWithStats: vi.fn() },
  loopApi: { onUpdated: vi.fn(() => () => {}) },
}))

const { FeatureSessions } = await import('./FeatureSessions')
const { useAppStore } = await import('@/store/appStore')

const repo: Repo = {
  id: 'r1',
  projectId: 'p1',
  label: 'claude-manager',
  path: '/repo',
  role: null,
  linkKind: 'local',
  source: null,
  position: 0,
  createdAt: 0,
  canvasX: null,
  canvasY: null,
  isHub: false,
}
const project = { id: 'p1', name: 'pitwall', icon: 'rocket', color: '#fff' } as Project

const reposById = new Map([[repo.id, repo]])
const projectsById = new Map([[project.id, project]])

function makeSession(over: Partial<FeatureSessionSummary> = {}): FeatureSessionSummary {
  return {
    id: 's1',
    ccSessionId: 'cc-1',
    title: 'ajustar parser',
    titleSource: 'auto',
    repoId: 'r1',
    status: 'exited',
    startedAt: 1000,
    endedAt: 2000,
    isLive: false,
    ...over,
  }
}

function renderList() {
  return render(
    <FeatureSessions featureId="f1" reposById={reposById} projectsById={projectsById} />,
  )
}

describe('FeatureSessions', () => {
  beforeEach(() => {
    useAppStore.setState({
      liveSessions: [],
      focusOrOpenSession: vi.fn().mockResolvedValue(undefined),
      resumeSession: vi.fn().mockResolvedValue(undefined),
      setArea: vi.fn(),
    })
  })

  it('sessão viva vira "focar" e leva pra pane existente', async () => {
    const live = { id: 's1', ccSessionId: 'cc-1' } as LiveSessionInfo
    useAppStore.setState({ liveSessions: [live] })
    listByFeature.mockResolvedValue([makeSession({ isLive: true, status: 'running', endedAt: null })])
    renderList()

    const action = await screen.findByTestId('feature-session-action')
    expect(action).toHaveAttribute('data-action', 'focus')
    expect(action).toHaveTextContent('focar')

    fireEvent.click(action)
    expect(useAppStore.getState().focusOrOpenSession).toHaveBeenCalledWith(live)
  })

  it('sessão morta vira "retomar" em um clique, sem perguntar nada', async () => {
    listByFeature.mockResolvedValue([makeSession({ isLive: false })])
    renderList()

    const action = await screen.findByTestId('feature-session-action')
    expect(action).toHaveAttribute('data-action', 'resume')
    expect(action).toHaveTextContent('retomar')

    fireEvent.click(action)
    expect(useAppStore.getState().resumeSession).toHaveBeenCalledWith(
      repo,
      'pitwall',
      'rocket',
      '#fff',
      'cc-1',
    )
    // Features e terminais são áreas exclusivas: retomar troca de tela.
    expect(useAppStore.getState().setArea).toHaveBeenCalledWith('projects')
  })

  it('ordena da mais recente pra mais antiga', async () => {
    listByFeature.mockResolvedValue([
      makeSession({ id: 'velha', title: 'velha', endedAt: 1000 }),
      makeSession({ id: 'nova', title: 'nova', endedAt: 9000 }),
    ])
    renderList()

    await screen.findByText('nova')
    const titles = screen.getAllByTestId('feature-session-action').length
    expect(titles).toBe(2)
    const rendered = screen.getByTestId('feature-sessions').textContent ?? ''
    expect(rendered.indexOf('nova')).toBeLessThan(rendered.indexOf('velha'))
  })

  it('estado vazio é honesto quando a feature não tem sessão', async () => {
    listByFeature.mockResolvedValue([])
    renderList()
    expect(await screen.findByText(/Nenhuma sessão trabalhou nesta feature/)).toBeInTheDocument()
  })

  it('não mente "nenhuma sessão" quando o IPC falha', async () => {
    listByFeature.mockRejectedValue(new Error('ipc down'))
    renderList()
    expect(await screen.findByText(/Não foi possível listar as sessões/)).toBeInTheDocument()
  })
})
