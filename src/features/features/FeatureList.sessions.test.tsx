import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FeatureList } from './FeatureList'
import type { Feature } from '../../../shared/types/ipc'

function makeFeature(): Feature {
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
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    archivedAt: null,
  }
}

describe('FeatureList — contagem de sessões', () => {
  it('a contagem deixa de ser texto morto e abre o dossiê', () => {
    const onSelect = vi.fn()
    render(
      <FeatureList
        features={[makeFeature()]}
        reposById={new Map()}
        sessionCounts={new Map([['f1', 3]])}
        statsById={new Map()}
        selectedId={null}
        onSelect={onSelect}
        onArchive={() => {}}
      />,
    )

    const count = screen.getByTestId('feature-card-sessions')
    expect(count).toHaveTextContent('3 sessões')
    fireEvent.click(count)
    expect(onSelect).toHaveBeenCalledWith('f1')
  })
})
