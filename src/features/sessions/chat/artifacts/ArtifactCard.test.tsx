import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignAgentActivity } from '@shared/types/design'

const { on, emit, handlers } = vi.hoisted(() => {
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
  return { on, emit, handlers }
})

vi.mock('@/lib/ipc', () => ({
  diagramsApi: {
    get: vi.fn(async () => null),
    onUpdated: on('diagram:updated'),
    onDeleted: on('diagram:deleted'),
  },
  designApi: {
    documentGet: vi.fn(async (id: string) => ({
      id,
      title: 'Landing',
      thumbnailVersion: null,
      pages: [{ artboards: [{ id: 'ab1' }] }],
    })),
    onAgentActivity: on('design:agent-activity'),
    onArtboardUpdated: on('design:artboard-updated'),
    onThumbnailUpdated: on('design:thumbnail-updated'),
    onDocumentUpdated: on('design:document-updated'),
    onDocumentDeleted: on('design:document-deleted'),
  },
}))
vi.mock('@/lib/nav', () => ({ navigateToDesign: vi.fn(), navigateToDiagram: vi.fn() }))

import { ArtifactCard } from './ArtifactCard'
import { navigateToDesign } from '@/lib/nav'
import type { ArtifactCardPlan } from './artifact-refs'

const plan: ArtifactCardPlan = {
  ref: { kind: 'design', id: 'doc-1' },
  title: null,
  calls: 3,
  lastTool: 'design_write_html',
}

function activity(docId: string, phase: DesignAgentActivity['phase']): DesignAgentActivity {
  return {
    docId,
    artboardId: 'ab1',
    nodeIds: [],
    tool: 'design_write_html',
    phase,
    sessionId: 's1',
    at: 0,
  }
}

beforeEach(() => handlers.clear())

describe('ArtifactCard', () => {
  it('coluna estreita: ações não quebram linha e viram só ícone com nome acessível', async () => {
    render(<ArtifactCard plan={plan} onShowSide={() => {}} />)
    await screen.findByText('Landing')
    const side = screen.getByRole('button', { name: 'Ver ao lado' })
    const open = screen.getByRole('button', { name: 'Abrir' })
    for (const btn of [side, open]) expect(btn.className).toContain('whitespace-nowrap')
    // O rótulo some por container query da coluna do chat (@container/chat).
    expect(side.querySelector('span')?.className).toMatch(/@max-\[\d+rem\]\/chat:sr-only/)
    expect(open.querySelector('span')?.className).toMatch(/@max-\[\d+rem\]\/chat:sr-only/)
    expect(screen.getByTestId('artifact-card').className).toContain('min-w-0')
  })

  it('mostra o título ao vivo e a contagem do turno', async () => {
    render(<ArtifactCard plan={plan} />)
    expect(await screen.findByText('Landing')).toBeInTheDocument()
    expect(screen.getByText('Editado · 3 chamadas neste turno')).toBeInTheDocument()
  })

  it('"Claude editando…" acende só com atividade deste documento', async () => {
    render(<ArtifactCard plan={plan} />)
    await screen.findByText('Landing')
    act(() => emit('design:agent-activity', activity('outro-doc', 'start')))
    expect(screen.queryByText('Claude editando…')).toBeNull()
    act(() => emit('design:agent-activity', activity('doc-1', 'start')))
    expect(screen.getByText('Claude editando…')).toBeInTheDocument()
    act(() => emit('design:agent-activity', activity('doc-1', 'end')))
    expect(screen.queryByText('Claude editando…')).toBeNull()
  })

  it('"Ver ao lado" entrega o ref e "Abrir" leva ao editor', async () => {
    const onShowSide = vi.fn()
    render(<ArtifactCard plan={plan} onShowSide={onShowSide} />)
    await screen.findByText('Landing')
    fireEvent.click(screen.getByRole('button', { name: /Ver ao lado/ }))
    expect(onShowSide).toHaveBeenCalledWith({ kind: 'design', id: 'doc-1' })
    fireEvent.click(screen.getByRole('button', { name: /Abrir/ }))
    expect(navigateToDesign).toHaveBeenCalledWith('doc-1')
  })

  it('diagrama removido vira estado "Removido" sem ações', async () => {
    render(<ArtifactCard plan={{ ...plan, ref: { kind: 'diagram', id: 'd-x' } }} />)
    expect(await screen.findByText('Removido')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Abrir/ })).toBeNull()
  })
})
