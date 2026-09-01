import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Feature, FeatureWithStats } from '../../../shared/types/ipc'
import type { SessionFeature } from './useSessionFeature'

const navigateToFeature = vi.fn()
vi.mock('@/lib/nav', () => ({
  navigateToFeature: (id: string) => navigateToFeature(id),
  navigateToObjective: vi.fn(),
  navigateToTask: vi.fn(),
  navigateToProject: vi.fn(),
  navigateToDiagram: vi.fn(),
}))

const listWithStats = vi.fn()
const setFeature = vi.fn()
const featureGet = vi.fn()
vi.mock('@/lib/ipc', () => ({
  featuresApi: {
    listWithStats: () => listWithStats(),
    get: (id: string) => featureGet(id),
  },
  sessionsApi: {
    setFeature: (sessionId: string, featureId: string | null) => setFeature(sessionId, featureId),
    listByFeature: vi.fn(),
  },
  loopApi: { onUpdated: vi.fn(() => () => {}) },
}))

const { SessionHeader } = await import('./SessionHeader')
const { useSessionFeatureStore } = await import('@/store/sessionFeatureStore')

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const feature: SessionFeature = {
  id: 'f-42',
  title: 'Extração TRF4',
  liveness: 'quiet',
  lastActivityAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
  issues: [],
}

function makeFeature(over: Partial<FeatureWithStats> & Pick<Feature, 'id' | 'title'>) {
  return {
    projectId: 'p1',
    slug: over.id,
    status: 'in-progress',
    objective: null,
    docPath: `/tmp/${over.id}.md`,
    synthMode: 'auto',
    model: null,
    repos: [{ repoId: 'r1', branch: null, worktreePath: null }],
    origin: 'manual',
    objectiveLinkCount: 0,
    isAppDev: false,
    pinned: false,
    focusRank: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    archivedAt: null,
    sessionCount: 0,
    recordCount: 0,
    lastRecordAt: null,
    ...over,
  } as FeatureWithStats
}

function renderHeader(over: Partial<Parameters<typeof SessionHeader>[0]> = {}) {
  render(
    <SessionHeader
      projectName="pitwall"
      repoLabel="claude-manager"
      repoPath="/repo"
      displayTitle="sessão"
      nameValue="sessão"
      isNamed
      canRename
      onCommitRename={() => {}}
      exited={false}
      activity={null}
      now={Date.now()}
      claudeNotFound={false}
      exitCode={null}
      error={null}
      mode="terminal"
      onMinimize={() => {}}
      onEndSession={() => {}}
      {...over}
    />,
  )
}

beforeEach(() => {
  navigateToFeature.mockClear()
  setFeature.mockClear().mockResolvedValue(undefined)
  featureGet.mockClear().mockResolvedValue(null)
  listWithStats.mockReset().mockResolvedValue([])
  useSessionFeatureStore.setState({ bySessionId: {}, featureTitles: {} })
})

describe('SessionHeader — volta pra feature', () => {
  it('mostra o chip com título + vitalidade e navega pra feature no clique', () => {
    renderHeader({ feature })
    const chip = screen.getByTestId('header-feature-chip')
    expect(chip).toHaveTextContent('Extração TRF4')
    expect(screen.getByTestId('liveness-chip')).toHaveAttribute('data-liveness', 'quiet')

    fireEvent.click(chip)
    expect(navigateToFeature).toHaveBeenCalledWith('f-42')
  })

  it('sessão sem feature não ganha chip', () => {
    renderHeader()
    expect(screen.queryByTestId('header-feature-chip')).not.toBeInTheDocument()
  })
})

describe('SessionHeader — vincular sessão em curso', () => {
  it('sessão sem feature oferece vincular; escolher grava e atualiza o índice', async () => {
    listWithStats.mockResolvedValue([
      makeFeature({ id: 'f-a', title: 'Loop das features', updatedAt: 10 }),
      makeFeature({ id: 'f-b', title: 'Voz sob demanda', updatedAt: 20, pinned: true }),
      makeFeature({ id: 'f-old', title: 'Arquivada', updatedAt: 99, archivedAt: 5 }),
    ])
    renderHeader({ sessionId: 's-1', repoId: 'r1' })

    fireEvent.click(screen.getByTestId('header-feature-link'))
    const options = await screen.findAllByRole('option')
    // Em foco no topo; arquivada fora da lista.
    expect(options.map((o) => o.getAttribute('data-feature-id'))).toEqual(['f-b', 'f-a'])

    fireEvent.click(options[1])
    await waitFor(() => expect(setFeature).toHaveBeenCalledWith('s-1', 'f-a'))
    await waitFor(() =>
      expect(useSessionFeatureStore.getState().bySessionId['s-1']).toBe('f-a'),
    )
  })

  it('a busca filtra por título', async () => {
    listWithStats.mockResolvedValue([
      makeFeature({ id: 'f-a', title: 'Loop das features' }),
      makeFeature({ id: 'f-b', title: 'Voz sob demanda' }),
    ])
    renderHeader({ sessionId: 's-1', repoId: 'r1' })

    fireEvent.click(screen.getByTestId('header-feature-link'))
    const search = await screen.findByTestId('header-feature-picker-search')
    fireEvent.change(search, { target: { value: 'voz' } })

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveAttribute('data-feature-id', 'f-b')
  })

  it('sessão já vinculada troca de frente pelo mesmo seletor', async () => {
    listWithStats.mockResolvedValue([makeFeature({ id: 'f-a', title: 'Loop das features' })])
    renderHeader({ feature, sessionId: 's-1', repoId: 'r1' })

    fireEvent.click(screen.getByTestId('header-feature-change'))
    const option = await screen.findByRole('option')
    fireEvent.click(option)

    await waitFor(() => expect(setFeature).toHaveBeenCalledWith('s-1', 'f-a'))
    await waitFor(() =>
      expect(useSessionFeatureStore.getState().bySessionId['s-1']).toBe('f-a'),
    )
  })

  it('sem sessionId (leitura pura) não oferece vincular', () => {
    renderHeader({ feature })
    expect(screen.queryByTestId('header-feature-change')).not.toBeInTheDocument()
    expect(screen.queryByTestId('header-feature-link')).not.toBeInTheDocument()
  })
})
