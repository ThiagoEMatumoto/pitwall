import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FeatureTriage } from './FeatureTriage'
import type { FeatureWithStats } from '../../../shared/types/ipc'

const NOW = Date.UTC(2026, 7, 31)

function makeFeature(over: Partial<FeatureWithStats> = {}): FeatureWithStats {
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
    origin: 'auto',
    objectiveLinkCount: 0,
    isAppDev: false,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    archivedAt: null,
    sessionCount: 0,
    recordCount: 0,
    lastRecordAt: null,
    ...over,
  }
}

describe('FeatureTriage', () => {
  it('cada linha diz por que está na fila', () => {
    render(
      <FeatureTriage
        features={[
          makeFeature({ id: 'a', origin: 'auto', title: 'Criada por agente' }),
          makeFeature({ id: 'b', origin: 'manual', title: 'Suspeita de duplicata' }),
        ]}
        suspectIds={new Set(['b'])}
        onSelect={vi.fn()}
        onArchive={vi.fn()}
        onDismissDuplicate={vi.fn()}
      />,
    )
    const rows = screen.getAllByTestId('feature-triage-row')
    expect(within(rows[0]).getByTestId('feature-triage-reason')).toHaveTextContent(
      'criada por agente',
    )
    expect(within(rows[1]).getByTestId('feature-triage-reason')).toHaveTextContent(
      'possível duplicata',
    )
  })

  it('os dois vereditos baratos da fila: abrir e arquivar', () => {
    const onSelect = vi.fn()
    const onArchive = vi.fn()
    render(
      <FeatureTriage
        features={[makeFeature({ id: 'a' })]}
        suspectIds={new Set()}
        onSelect={onSelect}
        onArchive={onArchive}
        onDismissDuplicate={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('feature-triage-open'))
    fireEvent.click(screen.getByTestId('feature-triage-archive'))
    expect(onSelect).toHaveBeenCalledWith('a')
    expect(onArchive).toHaveBeenCalledWith('a')
  })

  it('fila vazia explica que não há nada esperando decisão', () => {
    render(
      <FeatureTriage
        features={[]}
        suspectIds={new Set()}
        onSelect={vi.fn()}
        onArchive={vi.fn()}
        onDismissDuplicate={vi.fn()}
      />,
    )
    expect(screen.getByText(/Fila vazia/)).toBeInTheDocument()
    expect(screen.queryByTestId('feature-triage-row')).not.toBeInTheDocument()
  })
})
