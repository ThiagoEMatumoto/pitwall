import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const currentIds = vi.fn(async (ids: string[]) => ids.map((id) => (id === 's-old' ? 's-new' : id)))

vi.mock('@/lib/ipc', () => ({
  diagramsApi: {
    get: vi.fn(async () => ({
      id: 'd1',
      links: [
        { diagramId: 'd1', parentType: 'feature', parentId: 'f1' },
        { diagramId: 'd1', parentType: 'session', parentId: 's-old' },
      ],
    })),
    onLinksUpdated: () => () => {},
  },
  designApi: {},
  sessionsApi: { currentIds: (ids: string[]) => currentIds(ids) },
}))

import { useLinkedSessions } from './useLinkedSessions'

describe('useLinkedSessions', () => {
  it('link gravado antes do resume aponta para a linha atual da conversa', async () => {
    const { result } = renderHook(() => useLinkedSessions({ kind: 'diagram', id: 'd1' }))
    await waitFor(() => expect(result.current).toEqual(['s-new']))
    expect(currentIds).toHaveBeenCalledWith(['s-old'])
  })
})
