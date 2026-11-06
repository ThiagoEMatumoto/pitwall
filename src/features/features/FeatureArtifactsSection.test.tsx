import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { on, emit, handlers, data } = vi.hoisted(() => {
  type Handler = (payload: unknown) => void
  const handlers = new Map<string, Set<Handler>>()
  const on = (channel: string) => (h: Handler) => {
    if (!handlers.has(channel)) handlers.set(channel, new Set())
    handlers.get(channel)!.add(h)
    return () => handlers.get(channel)!.delete(h)
  }
  const emit = (channel: string, payload: unknown): void => {
    for (const h of handlers.get(channel) ?? []) h(payload)
  }
  const data = {
    diagrams: [] as Array<{ id: string; title: string; kind: string; updatedAt: number }>,
    docs: [] as Array<{ id: string; title: string; updatedAt: number; status: string }>,
  }
  return { on, emit, handlers, data }
})

vi.mock('@/lib/ipc', () => ({
  diagramsApi: {
    list: vi.fn(async () => data.diagrams),
    onLinksUpdated: on('diagramLinks:updated'),
    onDeleted: on('diagram:deleted'),
  },
  designApi: {
    documentsList: vi.fn(async () => data.docs),
    onLinksUpdated: on('design:links-updated'),
    onDocumentDeleted: on('design:document-deleted'),
  },
}))
vi.mock('@/lib/nav', () => ({ navigateToDesign: vi.fn(), navigateToDiagram: vi.fn() }))

import { FeatureArtifactsSection } from './FeatureArtifactsSection'
import { designApi, diagramsApi } from '@/lib/ipc'
import { navigateToDesign, navigateToDiagram } from '@/lib/nav'

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  handlers.clear()
  vi.mocked(navigateToDiagram).mockClear()
  vi.mocked(navigateToDesign).mockClear()
  data.diagrams = [{ id: 'd1', title: 'Fluxo de login', kind: 'flow', updatedAt: 1 }]
  data.docs = [
    { id: 'doc1', title: 'Tela de login', updatedAt: 2, status: 'active' },
    { id: 'doc2', title: 'Rascunho velho', updatedAt: 3, status: 'archived' },
  ]
})

async function renderSection(featureId = 'f1') {
  render(<FeatureArtifactsSection featureId={featureId} />)
  await act(() => vi.advanceTimersByTimeAsync(400))
}

describe('FeatureArtifactsSection', () => {
  it('pede ao main só os artefatos ligados à feature', async () => {
    await renderSection()
    expect(diagramsApi.list).toHaveBeenCalledWith({
      parentType: 'feature',
      parentId: 'f1',
      status: 'active',
    })
    expect(designApi.documentsList).toHaveBeenCalledWith({ parentType: 'feature', parentId: 'f1' })
  })

  it('lista título e tipo de cada artefato ativo, mais recente primeiro', async () => {
    await renderSection()
    const items = screen.getAllByTestId('feature-artifact')
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Tela de login'),
      expect.stringContaining('Fluxo de login'),
    ])
    expect(items[0].textContent).toContain('Design')
    expect(items[1].textContent).toContain('Fluxo')
    expect(screen.queryByText('Rascunho velho')).toBeNull()
  })

  it('abre o diagrama ou o design no editor ao clicar', async () => {
    await renderSection()
    fireEvent.click(screen.getByText('Fluxo de login'))
    expect(navigateToDiagram).toHaveBeenCalledWith('d1')
    fireEvent.click(screen.getByText('Tela de login'))
    expect(navigateToDesign).toHaveBeenCalledWith('doc1')
  })

  it('mostra estado vazio quando não há artefato ligado', async () => {
    data.diagrams = []
    data.docs = []
    await renderSection()
    expect(screen.getByText(/Nenhum diagrama ou design ligado/)).toBeTruthy()
  })

  it('recarrega quando um link de diagrama muda', async () => {
    data.diagrams = []
    data.docs = []
    await renderSection()
    expect(screen.queryAllByTestId('feature-artifact')).toHaveLength(0)
    data.diagrams = [{ id: 'd2', title: 'ER novo', kind: 'er', updatedAt: 5 }]
    act(() => emit('diagramLinks:updated', {}))
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(screen.getByText('ER novo')).toBeTruthy()
  })
})
