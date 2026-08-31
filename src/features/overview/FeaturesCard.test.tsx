import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Feature, OverviewFeatureActivity } from '../../../shared/types/ipc'

const list = vi.fn()
const snapshot = vi.fn()
vi.mock('@/lib/ipc', () => ({
  featuresApi: {
    list: (...args: unknown[]) => list(...args),
    onUpdated: vi.fn(() => () => {}),
  },
  loopApi: {
    snapshot: (id: string) => snapshot(id),
    onUpdated: vi.fn(() => () => {}),
  },
}))
vi.mock('@/store/appStore', () => ({
  useAppStore: (selector: (s: unknown) => unknown) => selector({ setArea: vi.fn() }),
}))
vi.mock('@/store/featuresStore', () => ({
  useFeaturesStore: Object.assign(() => undefined, { getState: () => ({ select: vi.fn() }) }),
}))

const { FeaturesCard } = await import('./FeaturesCard')

const NOW = Date.UTC(2026, 7, 31)

function makeFeature(over: Partial<Feature> & Record<string, unknown> = {}): Feature {
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
    repos: [],
    origin: 'manual',
    objectiveLinkCount: 1,
    isAppDev: false,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    archivedAt: null,
    ...over,
  } as Feature
}

const activity: OverviewFeatureActivity = {
  id: 'x1',
  title: 'Frente por atividade',
  status: 'in-progress',
  projectId: 'p1',
  lastSessionAt: NOW,
  sessionCount: 2,
  objectiveLinkCount: 1,
}

describe('FeaturesCard — features em foco', () => {
  it('sem pin nenhum, o card segue mostrando a atividade', async () => {
    list.mockResolvedValue([makeFeature()])
    render(<FeaturesCard features={[activity]} />)

    expect(await screen.findByText('Frente por atividade')).toBeInTheDocument()
    expect(screen.queryByTestId('home-pinned-features')).not.toBeInTheDocument()
  })

  it('com pin, lista as em foco com pulso truncado e chip de vitalidade', async () => {
    list.mockResolvedValue([makeFeature({ id: 'a', pinned: true, title: 'Extração TRF4' })])
    snapshot.mockResolvedValue({
      featureId: 'a',
      pulse: {
        id: 'p1',
        featureId: 'a',
        body: 'Parser em staging, falta calibrar.',
        source: 'human',
        sessionId: null,
        createdAt: NOW,
      },
      liveness: 'alive',
      issues: [],
      ledger: [],
      metrics: [],
      lastActivityAt: NOW,
    })
    render(<FeaturesCard features={[activity]} />)

    const row = await screen.findByTestId('home-pinned-feature')
    expect(row).toHaveAttribute('data-feature-id', 'a')
    expect(row).toHaveTextContent('Parser em staging, falta calibrar.')
    expect(await screen.findByTestId('liveness-chip')).toHaveAttribute('data-liveness', 'alive')
    // O foco toma o lugar da lista de atividade — o card tem altura fixa.
    expect(screen.queryByText('Frente por atividade')).not.toBeInTheDocument()
  })
})
