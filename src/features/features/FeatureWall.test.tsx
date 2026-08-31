import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Feature, FeatureLoopSnapshot } from '../../../shared/types/ipc'

vi.mock('@/lib/ipc', () => ({ featuresApi: {} }))

const { FeatureWall } = await import('./FeatureWall')

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
    objectiveLinkCount: 0,
    isAppDev: false,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    archivedAt: null,
    ...over,
  } as Feature
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
    liveness: 'alive',
    issues: [],
    ledger: [],
    metrics: [],
    lastActivityAt: NOW,
    pinned: true,
    focusRank: null,
    duplicateSuspect: null,
    ...over,
  }
}

function renderWall(over: Partial<Parameters<typeof FeatureWall>[0]> = {}) {
  const props = {
    pinned: [] as Feature[],
    features: [] as Feature[],
    snapshots: new Map<string, FeatureLoopSnapshot>(),
    liveByFeature: new Map<string, number>(),
    reposById: new Map(),
    sessionCounts: new Map<string, number>(),
    statsById: new Map(),
    selectedId: null,
    onSelect: vi.fn(),
    onArchive: vi.fn(),
    onTogglePin: vi.fn(),
    ...over,
  }
  render(<FeatureWall {...props} />)
  return props
}

describe('FeatureWall', () => {
  it('mostra as pinadas em cima, na ordem recebida, com pulso e vitalidade', () => {
    renderWall({
      pinned: [
        makeFeature({ id: 'a', title: 'Extração TRF4' }),
        makeFeature({ id: 'b', title: 'Voz sob demanda' }),
      ],
      features: [makeFeature({ id: 'c', title: 'Resto por atividade' })],
      snapshots: new Map([['a', makeSnapshot({ featureId: 'a', liveness: 'quiet' })]]),
    })

    const cards = screen.getAllByTestId('feature-wall-card')
    expect(cards.map((c) => c.getAttribute('data-feature-id'))).toEqual(['a', 'b'])
    expect(within(cards[0]).getByText('Parser em staging, falta calibrar.')).toBeInTheDocument()
    expect(within(cards[0]).getByTestId('liveness-chip')).toHaveAttribute('data-liveness', 'quiet')
    // Sem snapshot o card não mente: diz que falta pulso em vez de ficar vazio.
    expect(within(cards[1]).getByText(/sem pulso/)).toBeInTheDocument()
    // A lista plana continua embaixo, e não repete quem já está em foco.
    expect(screen.getByText('Resto por atividade')).toBeInTheDocument()
  })

  it('sinaliza a sessão viva da feature em foco', () => {
    renderWall({
      pinned: [makeFeature({ id: 'a' })],
      liveByFeature: new Map([['a', 2]]),
    })
    expect(screen.getByTestId('feature-wall-live')).toHaveTextContent('2 sessões vivas')
  })

  it('sem nada em foco, o vazio convida a fixar a feature mais ativa', () => {
    const props = renderWall({
      features: [makeFeature({ id: 'c', title: 'Extração TRF4' })],
    })
    expect(screen.getByTestId('feature-wall-empty-focus')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('feature-wall-pin-suggestion'))
    expect(props.onTogglePin).toHaveBeenCalledWith('c', true)
  })

  it('o card em foco desafixa sem abrir o dossiê', () => {
    const props = renderWall({ pinned: [makeFeature({ id: 'a' })] })
    fireEvent.click(screen.getByTestId('feature-wall-unpin'))
    expect(props.onTogglePin).toHaveBeenCalledWith('a', false)
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('o pin da lista plana usa o estado atual da feature pra decidir o alvo', () => {
    const props = renderWall({
      features: [makeFeature({ id: 'c', pinned: true, title: 'Já fixada' })],
    })
    const toggle = screen.getByTestId('feature-card-pin')
    expect(toggle).toHaveAttribute('data-pinned', 'true')
    fireEvent.click(toggle)
    expect(props.onTogglePin).toHaveBeenCalledWith('c', false)
  })
})
