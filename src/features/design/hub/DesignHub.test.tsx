import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignAgentActivity, DesignDocumentMeta, DesignFolder } from '@shared/types/design'

const mockApi = {
  documentsList: vi.fn().mockResolvedValue([]),
  documentGet: vi.fn().mockResolvedValue(null),
  activeDocSet: vi.fn().mockResolvedValue(undefined),
  liveState: vi.fn().mockResolvedValue([]),
  thumbnailsBackfill: vi.fn().mockResolvedValue(0),
  folderDelete: vi.fn().mockResolvedValue(undefined),
  documentMove: vi.fn(),
}
vi.mock('@/lib/ipc', () => ({ api: { design: mockApi } }))
vi.mock('@/features/notifications/toast-store', () => ({
  showToast: vi.fn(),
  dismissToast: vi.fn(),
}))
vi.mock('../ask-claude/AskClaudeComposer', () => ({ AskClaudeComposer: () => null }))

const { useDesignStore } = await import('@/store/designStore')
const { DesignHub } = await import('./DesignHub')

function meta(
  id: string,
  title: string,
  folderId: string | null,
  updatedAt: number,
): DesignDocumentMeta {
  return { id, title, status: 'active', folderId, thumbnailVersion: null, createdAt: 1, updatedAt }
}

function folder(id: string, name: string, docCount: number): DesignFolder {
  return { id, name, color: 'accent', sortOrder: 0, docCount, createdAt: 1, updatedAt: 1 }
}

const DOCS = [
  meta('d1', 'Landing page', 'f1', 300),
  meta('d2', 'Ícones', null, 200),
  meta('d3', 'App mobile', 'f1', 100),
]

function cardTitles(): string[] {
  return screen
    .getAllByTestId('doc-card')
    .map((c) => within(c).getAllByRole('button')[0].textContent ?? '')
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useDesignStore.setState({
    docs: DOCS,
    archivedDocs: [],
    folders: [folder('f1', 'Cliente Acme', 2), folder('f2', 'Vazia', 0)],
    docId: null,
    doc: null,
    hubFolder: 'recent',
    hubQuery: '',
    hubSort: 'recent',
    loading: false,
    error: null,
    activityByDoc: {},
    lastSeenAt: {},
    lastFinishAt: {},
  })
})

describe('DesignHub', () => {
  it('lists sections and folders, and backfills thumbnails once on mount', () => {
    render(<DesignHub />)
    const nav = screen.getByRole('navigation', { name: 'Seções de designs' })
    for (const label of ['Recentes', 'Cliente Acme', 'Vazia', 'Sem pasta', 'Arquivados']) {
      expect(within(nav).getByRole('button', { name: new RegExp(`^${label}`) })).toBeInTheDocument()
    }
    expect(screen.getByRole('heading', { name: 'Recentes' })).toBeInTheDocument()
    expect(cardTitles()).toEqual(['Landing page', 'Ícones', 'App mobile'])
    expect(mockApi.thumbnailsBackfill).toHaveBeenCalledTimes(1)
  })

  it('shows the folder chip in Recentes and filters by folder', () => {
    render(<DesignHub />)
    const landing = screen.getAllByTestId('doc-card')[0]
    expect(within(landing).getByText('Cliente Acme')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Cliente Acme/ }))
    expect(useDesignStore.getState().hubFolder).toBe('f1')
    expect(cardTitles()).toEqual(['Landing page', 'App mobile'])
    // Inside the folder the chip is redundant.
    expect(within(screen.getAllByTestId('doc-card')[0]).queryByText('Cliente Acme')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Sem pasta/ }))
    expect(cardTitles()).toEqual(['Ícones'])
  })

  it('filters by title ignoring accents and shows the no-match state', () => {
    render(<DesignHub />)
    const search = screen.getByRole('searchbox', { name: 'Buscar designs' })
    fireEvent.change(search, { target: { value: 'icones' } })
    expect(cardTitles()).toEqual(['Ícones'])

    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText('Nenhum design com “zzz”')).toBeInTheDocument()
    // The header's × and the empty state's button do the same thing.
    fireEvent.click(screen.getAllByRole('button', { name: 'Limpar busca' }).at(-1)!)
    expect(cardTitles()).toHaveLength(3)
  })

  it('sorts by name and remembers the choice', () => {
    render(<DesignHub />)
    fireEvent.click(screen.getByRole('button', { name: 'Nome' }))
    expect(cardTitles()).toEqual(['App mobile', 'Ícones', 'Landing page'])
    expect(JSON.parse(localStorage.getItem('pitwall.design.hub') ?? '{}').hubSort).toBe('name')
  })

  it('shows the working dot and the "novo" badge on the right cards', () => {
    const working: DesignAgentActivity = {
      docId: 'd2',
      artboardId: 'ab1',
      nodeIds: [],
      tool: 'design_nodes_upsert',
      phase: 'start',
      sessionId: 's1',
      at: Date.now(),
    }
    useDesignStore.setState({
      activityByDoc: { d2: { ab1: [working] } },
      lastFinishAt: { d1: 500, d3: 50 },
      lastSeenAt: { d1: 400, d3: 90 },
    })
    render(<DesignHub />)
    const [landing, icones, app] = screen.getAllByTestId('doc-card')
    expect(within(icones).getByRole('status', { name: 'Claude trabalhando' })).toBeInTheDocument()
    expect(within(landing).queryByRole('status')).toBeNull()
    expect(within(landing).getByText('novo')).toBeInTheDocument()
    // Finished before the last visit: nothing new.
    expect(within(app).queryByText('novo')).toBeNull()
  })

  it('renders the thumbnail and falls back to the placeholder on a 404', () => {
    useDesignStore.setState({ docs: [{ ...DOCS[0], thumbnailVersion: 'v1' }] })
    const { container } = render(<DesignHub />)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('pitwall-design://thumb/d1?v=v1')
    fireEvent.error(img!)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('thumb-placeholder')).toBeInTheDocument()
  })

  it('opens a document when its card is activated', async () => {
    render(<DesignHub />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ícones' }))
    })
    expect(mockApi.documentGet).toHaveBeenCalledWith('d2')
  })

  it('teaches the empty folder and the first use', () => {
    useDesignStore.setState({ hubFolder: 'f2' })
    const view = render(<DesignHub />)
    expect(screen.getByText('Arraste designs para cá ou crie um novo.')).toBeInTheDocument()
    view.unmount()

    useDesignStore.setState({ docs: [], hubFolder: 'recent' })
    render(<DesignHub />)
    expect(screen.getByText('Seu primeiro design começa aqui')).toBeInTheDocument()
  })

  it('deletes a folder only after the inline confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    render(<DesignHub />)
    fireEvent.click(screen.getByRole('button', { name: 'Opções da pasta Cliente Acme' }))
    fireEvent.click(screen.getByRole('button', { name: 'Excluir…' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Excluir a pasta Cliente Acme' })
    expect(mockApi.folderDelete).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }))
    })
    expect(mockApi.folderDelete).toHaveBeenCalledWith('f1')
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /^Cliente Acme/ })).toBeNull()
  })
})
