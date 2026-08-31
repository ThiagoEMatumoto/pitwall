import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Feature, FeatureLoopSnapshot } from '../../../shared/types/ipc'

// Smoke da COSTURA do header (pulso + liveness). As seções de tarefas e
// objetivos são mockadas: elas têm IPC próprio e não são o alvo deste teste.
vi.mock('./FeatureTasksSection', () => ({ FeatureTasksSection: () => null }))
vi.mock('./FeatureObjectiveLinksSection', () => ({ FeatureObjectiveLinksSection: () => null }))
vi.mock('./useObjectiveLookups', () => ({
  useObjectiveLookups: () => ({ objectives: [], krTitles: new Map(), krObjectiveId: new Map() }),
}))

const snapshotMock = vi.fn()
vi.mock('@/lib/ipc', () => ({
  shellApi: { openPath: vi.fn() },
  // O dossiê agora lista as sessões da feature e sabe abrir uma nova.
  sessionsApi: { listByFeature: vi.fn().mockResolvedValue([]) },
  featuresApi: { list: vi.fn().mockResolvedValue([]), get: vi.fn() },
  prefsApi: { get: vi.fn().mockResolvedValue(null), set: vi.fn() },
  loopApi: {
    snapshot: (id: string) => snapshotMock(id),
    setPulse: vi.fn(),
    pulseHistory: vi.fn().mockResolvedValue([]),
    onUpdated: vi.fn(() => () => {}),
  },
}))

const { FeatureDoc } = await import('./FeatureDoc')

const NOW = Date.UTC(2026, 0, 30)

function makeFeature(over: Partial<Feature> = {}): Feature {
  return {
    id: 'f1',
    projectId: 'proj',
    slug: 'trf4',
    title: 'Extração TRF4',
    status: 'in-progress',
    objective: null,
    docPath: '/tmp/f1.md',
    synthMode: 'auto',
    model: null,
    repos: [],
    origin: 'manual',
    objectiveLinkCount: 0,
    isAppDev: false,
    createdAt: NOW - 1000,
    updatedAt: NOW,
    completedAt: null,
    archivedAt: null,
    body: '# Doc',
    ...over,
  }
}

function makeSnapshot(over: Partial<FeatureLoopSnapshot> = {}): FeatureLoopSnapshot {
  return {
    featureId: 'f1',
    pulse: {
      id: 'p1',
      featureId: 'f1',
      body: 'Parser em staging, falta calibrar.',
      source: 'session',
      sessionId: 's1',
      createdAt: NOW,
    },
    liveness: 'quiet',
    issues: [],
    ledger: [],
    metrics: [],
    lastActivityAt: NOW - 23 * 24 * 60 * 60 * 1000,
    ...over,
  }
}

describe('FeatureDoc (costura do loop)', () => {
  it('header mostra o pulso vigente e o chip de liveness junto do status', async () => {
    snapshotMock.mockResolvedValue(makeSnapshot())
    render(<FeatureDoc feature={makeFeature()} loading={false} reposById={new Map()} />)

    expect(await screen.findByText('Parser em staging, falta calibrar.')).toBeInTheDocument()
    const chip = screen.getByTestId('liveness-chip')
    expect(chip).toHaveAttribute('data-liveness', 'quiet')
    expect(chip).toHaveTextContent('silêncio')
    // O status manual continua no header — só perde o primeiro plano.
    expect(screen.getByText('em andamento')).toBeInTheDocument()
  })

  it('snapshot que falha não derruba o doc: cai no estado sem pulso', async () => {
    snapshotMock.mockRejectedValue(new Error('feature not found: f1'))
    render(<FeatureDoc feature={makeFeature()} loading={false} reposById={new Map()} />)

    expect(await screen.findByText('sem pulso')).toBeInTheDocument()
    expect(screen.queryByTestId('liveness-chip')).not.toBeInTheDocument()
    expect(screen.getByText('Extração TRF4')).toBeInTheDocument()
  })
})
