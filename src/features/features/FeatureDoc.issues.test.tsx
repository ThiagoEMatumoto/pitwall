import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Feature, FeatureLoopSnapshot } from '../../../shared/types/ipc'

// Costura da faixa de higiene com o dossiê. Tarefas e objetivos têm IPC próprio
// e ficam fora do alvo — o que importa aqui é issue → gesto.
vi.mock('./FeatureTasksSection', () => ({ FeatureTasksSection: () => null }))
vi.mock('./FeatureObjectiveLinksSection', () => ({ FeatureObjectiveLinksSection: () => null }))
vi.mock('./FeatureSessions', () => ({ FeatureSessions: () => null }))
vi.mock('./useObjectiveLookups', () => ({
  useObjectiveLookups: () => ({ objectives: [], krTitles: new Map(), krObjectiveId: new Map() }),
}))

const snapshotMock = vi.fn()
const select = vi.fn()
vi.mock('@/store/featuresStore', () => ({
  useFeaturesStore: Object.assign(() => undefined, {
    getState: () => ({ select, refresh: vi.fn() }),
  }),
}))
vi.mock('@/lib/ipc', () => ({
  shellApi: { openPath: vi.fn() },
  sessionsApi: { listByFeature: vi.fn().mockResolvedValue([]) },
  featuresApi: { list: vi.fn().mockResolvedValue([]), get: vi.fn(), archive: vi.fn(), update: vi.fn() },
  prefsApi: { get: vi.fn().mockResolvedValue(null), set: vi.fn() },
  loopApi: {
    snapshot: (id: string) => snapshotMock(id),
    setPulse: vi.fn(),
    pulseHistory: vi.fn().mockResolvedValue([]),
    onUpdated: vi.fn(() => () => {}),
  },
}))

const { FeatureDoc } = await import('./FeatureDoc')

const NOW = Date.UTC(2026, 7, 31)

function makeFeature(over: Partial<Feature> = {}): Feature {
  return {
    id: 'f1',
    projectId: 'proj',
    slug: 'trf4',
    title: 'Extração TRF4',
    status: 'in-progress',
    objective: 'Extrair processos do TRF4.',
    docPath: '/tmp/f1.md',
    synthMode: 'auto',
    model: null,
    repos: [{ repoId: 'r1', branch: null }],
    origin: 'auto',
    objectiveLinkCount: 1,
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
    pulse: null,
    liveness: 'quiet',
    issues: [],
    ledger: [],
    metrics: [],
    lastActivityAt: NOW,
    ...over,
  }
}

function renderDoc(feature = makeFeature()) {
  render(
    <FeatureDoc
      feature={feature}
      loading={false}
      reposById={new Map()}
      projectsById={new Map()}
    />,
  )
}

describe('FeatureDoc — faixa de issues', () => {
  it('sem issue a faixa não aparece', async () => {
    snapshotMock.mockResolvedValue(
      makeSnapshot({
        pulse: {
          id: 'p1',
          featureId: 'f1',
          body: 'Parser em staging.',
          source: 'human',
          sessionId: null,
          createdAt: NOW,
        },
      }),
    )
    renderDoc()
    expect(await screen.findByText('Parser em staging.')).toBeInTheDocument()
    expect(screen.queryByTestId('feature-issues')).not.toBeInTheDocument()
  })

  it('lista as issues do snapshot e o gesto de pulso abre o editor', async () => {
    snapshotMock.mockResolvedValue(
      makeSnapshot({
        issues: [{ level: 'warn', code: 'pulse_missing', message: 'Sem pulso.' }],
      }),
    )
    renderDoc()

    fireEvent.click(await screen.findByTestId('feature-issue-pulse'))
    expect(screen.getByLabelText('Pulso da feature')).toBeInTheDocument()
  })

  it('feature sem OKR ganha a issue derivada, que leva ao vínculo', async () => {
    snapshotMock.mockResolvedValue(makeSnapshot())
    renderDoc(makeFeature({ objectiveLinkCount: 0 }))

    const row = await screen.findByTestId('feature-issue')
    expect(row).toHaveAttribute('data-code', 'okr_missing')
    expect(screen.getByTestId('feature-issue-okr')).toBeInTheDocument()
  })

  it('a duplicata do snapshot abre o candidato pelo store', async () => {
    snapshotMock.mockResolvedValue({
      ...makeSnapshot({
        issues: [
          { level: 'warn', code: 'duplicate_suspect', message: 'Possível duplicata de «TRF4».' },
        ],
      }),
      duplicateSuspect: { candidateId: 'f9', title: 'Extração TRF4 (antiga)', score: 0.82 },
    })
    renderDoc()

    fireEvent.click(await screen.findByTestId('feature-issue-open-candidate'))
    expect(select).toHaveBeenCalledWith('f9')
  })

  it('objective_missing abre o editor do resumo dentro do app', async () => {
    snapshotMock.mockResolvedValue(
      makeSnapshot({
        issues: [{ level: 'warn', code: 'objective_missing', message: 'Objetivo vazio.' }],
      }),
    )
    renderDoc(makeFeature({ objective: null }))

    fireEvent.click(await screen.findByTestId('feature-issue-objective'))
    expect(screen.getByLabelText('Objetivo da feature')).toBeInTheDocument()
  })
})
