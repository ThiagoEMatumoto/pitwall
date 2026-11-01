import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { on, emit, handlers, data, focusOrOpenSession, live } = vi.hoisted(() => {
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
    diagrams: [] as Array<{ id: string; title: string; updatedAt: number }>,
    docs: [] as Array<{ id: string; title: string; updatedAt: number; status: string }>,
  }
  const live = { current: null as null | { id: string } }
  return { on, emit, handlers, data, focusOrOpenSession: vi.fn(), live }
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
vi.mock('@/store/appStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) =>
    sel({ liveSessions: live.current ? [live.current] : [], focusOrOpenSession }),
}))
vi.mock('@/lib/nav', () => ({ navigateToDesign: vi.fn(), navigateToDiagram: vi.fn() }))

import { SessionArtifactChips } from './SessionArtifactChips'
import { useArtifactPanelStore } from './artifactPanelStore'
import { diagramsApi } from '@/lib/ipc'
import { navigateToDiagram } from '@/lib/nav'

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  handlers.clear()
  focusOrOpenSession.mockClear()
  data.diagrams = [{ id: 'd1', title: 'Arquitetura', updatedAt: 1 }]
  data.docs = [{ id: 'doc1', title: 'Landing', updatedAt: 2, status: 'active' }]
  live.current = { id: 's1' }
})

describe('SessionArtifactChips', () => {
  it('pede ao main só os artefatos ligados à sessão, mais recente primeiro', async () => {
    render(<SessionArtifactChips sessionId="s1" />)
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(diagramsApi.list).toHaveBeenCalledWith({
      parentType: 'session',
      parentId: 's1',
      status: 'active',
    })
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Landing',
      'Arquitetura',
    ])
  })

  it('sessão viva: abre o painel ao lado do chat e foca a sessão', async () => {
    render(<SessionArtifactChips sessionId="s1" />)
    await act(() => vi.advanceTimersByTimeAsync(400))
    fireEvent.click(screen.getByRole('button', { name: /Arquitetura/ }))
    expect(useArtifactPanelStore.getState().sessions.s1).toEqual({
      ref: { kind: 'diagram', id: 'd1' },
      open: true,
    })
    expect(focusOrOpenSession).toHaveBeenCalledWith({ id: 's1' })
  })

  it('sessão encerrada abre no editor; link novo recarrega', async () => {
    live.current = null
    data.diagrams = []
    data.docs = []
    render(<SessionArtifactChips sessionId="s1" />)
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(screen.queryByTestId('session-artifact-chips')).toBeNull()
    data.diagrams = [{ id: 'd2', title: 'Fluxo', updatedAt: 3 }]
    act(() => emit('diagramLinks:updated', { diagramId: 'd2', links: [] }))
    await act(() => vi.advanceTimersByTimeAsync(400))
    fireEvent.click(screen.getByRole('button', { name: /Fluxo/ }))
    expect(navigateToDiagram).toHaveBeenCalledWith('d2')
  })
})
