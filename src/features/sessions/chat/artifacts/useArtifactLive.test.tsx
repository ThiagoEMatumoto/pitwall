import { act, render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { on, emit, renderThumbnail } = vi.hoisted(() => {
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
  const renderThumbnail = vi.fn(async () => 'data:image/png;base64,AAA')
  return { on, emit, renderThumbnail }
})

const diagram = (version: number) => ({
  id: 'd1',
  title: 'Arquitetura',
  version,
  thumbnail: null,
  scene: { elements: [{ id: 'api', type: 'rectangle', version }] },
})

vi.mock('@/lib/ipc', () => ({
  diagramsApi: {
    get: vi.fn(async () => diagram(1)),
    onUpdated: on('diagram:updated'),
    onDeleted: on('diagram:deleted'),
  },
  designApi: {},
}))
vi.mock('@/features/diagrams/excalidraw-lazy', () => ({
  loadExcalidrawUtils: async () => ({}),
}))
vi.mock('@/features/diagrams/diagram-thumbnail', () => ({ renderThumbnail }))

import { useArtifactLive } from './useArtifactLive'

function Probe({ onLive }: { onLive: (thumb: string | null) => void }) {
  const live = useArtifactLive({ kind: 'diagram', id: 'd1' })
  onLive(live.thumbnail)
  return null
}

describe('useArtifactLive — thumbnail de diagrama', () => {
  it('três cards do mesmo diagrama renderizam a thumbnail uma vez por versão', async () => {
    const thumbs: Array<string | null> = []
    render(
      <>
        <Probe onLive={(t) => thumbs.push(t)} />
        <Probe onLive={(t) => thumbs.push(t)} />
        <Probe onLive={(t) => thumbs.push(t)} />
      </>,
    )
    await waitFor(() => expect(thumbs.at(-1)).toBe('data:image/png;base64,AAA'))
    expect(renderThumbnail).toHaveBeenCalledTimes(1)

    await act(async () => {
      emit('diagram:updated', diagram(2))
    })
    await waitFor(() => expect(renderThumbnail).toHaveBeenCalledTimes(2))
    // Mesma versão de novo (eco do save do editor) não renderiza outra vez.
    await act(async () => {
      emit('diagram:updated', diagram(2))
    })
    expect(renderThumbnail).toHaveBeenCalledTimes(2)
  })
})
