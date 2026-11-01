import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DesignAgentActivity,
  DesignDocument,
  DesignDocumentMeta,
  DesignFolder,
} from '@shared/types/design'

type Handler = (payload: unknown) => void
const handlers: Record<string, Handler> = {}
const on = (name: string) =>
  vi.fn((h: Handler) => {
    handlers[name] = h
    return () => delete handlers[name]
  })

const mockApi = {
  documentsList: vi.fn().mockResolvedValue([]),
  documentGet: vi.fn(),
  documentUpdate: vi.fn(),
  documentArchive: vi.fn(),
  documentUnarchive: vi.fn(),
  activeDocSet: vi.fn().mockResolvedValue(undefined),
  selectionSet: vi.fn().mockResolvedValue(undefined),
  pageUpdate: vi.fn().mockResolvedValue(undefined),
  liveState: vi.fn().mockResolvedValue([]),
  foldersList: vi.fn().mockResolvedValue([]),
  folderCreate: vi.fn(),
  folderUpdate: vi.fn(),
  folderDelete: vi.fn().mockResolvedValue(undefined),
  documentMove: vi.fn(),
  onArtboardUpdated: on('artboardUpdated'),
  onAgentActivity: on('agentActivity'),
  onDocumentUpdated: on('documentUpdated'),
  onArtboardDeleted: on('artboardDeleted'),
  onDocumentDeleted: on('documentDeleted'),
  onFoldersUpdated: on('foldersUpdated'),
  onThumbnailUpdated: on('thumbnailUpdated'),
}

vi.mock('@/lib/ipc', () => ({ api: { design: mockApi } }))
vi.mock('@/features/notifications/toast-store', () => ({
  showToast: vi.fn(),
  dismissToast: vi.fn(),
}))

const { useDesignStore } = await import('./designStore')
const { handleAgentActivity } = await import('./designStore.remote')
const { loadHubPrefs } = await import('./designStore.hub')

function meta(id: string, folderId: string | null = null, updatedAt = 1): DesignDocumentMeta {
  return {
    id,
    title: id,
    status: 'active',
    folderId,
    thumbnailVersion: null,
    createdAt: 1,
    updatedAt,
  }
}

function folder(id: string, docCount = 0, sortOrder = 0): DesignFolder {
  return { id, name: id, color: null, sortOrder, docCount, createdAt: 1, updatedAt: 1 }
}

function fullDoc(m: DesignDocumentMeta): DesignDocument {
  return { ...m, tokens: {}, fonts: [], globalCss: '', nodeIds: [], pages: [] } as DesignDocument
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useDesignStore.getState().stopWatch()
  useDesignStore.setState({
    docs: [],
    archivedDocs: [],
    folders: [],
    docId: null,
    doc: null,
    hubFolder: 'recent',
    hubSort: 'recent',
    error: null,
    lastFinishAt: {},
  })
})

describe('folders', () => {
  it('loads folders and drops a remembered folder that no longer exists', async () => {
    useDesignStore.setState({ hubFolder: 'gone' })
    mockApi.foldersList.mockResolvedValue([folder('a')])
    await useDesignStore.getState().loadFolders()
    expect(useDesignStore.getState().folders.map((f) => f.id)).toEqual(['a'])
    expect(useDesignStore.getState().hubFolder).toBe('recent')
  })

  it('keeps folders ordered by sortOrder then name on create and rename', async () => {
    useDesignStore.setState({ folders: [folder('b', 0, 1)] })
    mockApi.folderCreate.mockResolvedValue(folder('a', 0, 0))
    await useDesignStore.getState().createFolder('a')
    expect(useDesignStore.getState().folders.map((f) => f.id)).toEqual(['a', 'b'])

    mockApi.folderUpdate.mockResolvedValue({ ...folder('b', 0, 1), name: 'Bravo' })
    await useDesignStore.getState().renameFolder('b', 'Bravo')
    expect(mockApi.folderUpdate).toHaveBeenCalledWith('b', { name: 'Bravo' })
    expect(useDesignStore.getState().folders[1].name).toBe('Bravo')
  })

  it('deleting the selected folder unfiles its docs and returns to Recentes', async () => {
    useDesignStore.setState({
      folders: [folder('a', 1)],
      docs: [meta('d1', 'a')],
      hubFolder: 'a',
    })
    await useDesignStore.getState().deleteFolder('a')
    const s = useDesignStore.getState()
    expect(s.folders).toEqual([])
    expect(s.docs[0].folderId).toBeNull()
    expect(s.hubFolder).toBe('recent')
  })
})

describe('moveDoc', () => {
  it('moves optimistically and shifts the folder counts', async () => {
    let resolve!: (m: DesignDocumentMeta) => void
    mockApi.documentMove.mockReturnValue(new Promise((r) => (resolve = r)))
    useDesignStore.setState({ folders: [folder('a', 1), folder('b', 0)], docs: [meta('d1', 'a')] })

    const pending = useDesignStore.getState().moveDoc('d1', 'b')
    // Before main answers, the card and the counts already moved.
    expect(useDesignStore.getState().docs[0].folderId).toBe('b')
    expect(useDesignStore.getState().folders.map((f) => f.docCount)).toEqual([0, 1])

    resolve(meta('d1', 'b'))
    await pending
    expect(mockApi.documentMove).toHaveBeenCalledWith('d1', 'b')
    expect(useDesignStore.getState().error).toBeNull()
  })

  it('reverts the move and reports when main refuses', async () => {
    mockApi.documentMove.mockRejectedValue(new Error('folder not found'))
    useDesignStore.setState({ folders: [folder('a', 1)], docs: [meta('d1', 'a')] })

    await useDesignStore.getState().moveDoc('d1', null)
    const s = useDesignStore.getState()
    expect(s.docs[0].folderId).toBe('a')
    expect(s.folders[0].docCount).toBe(1)
    expect(s.error).toContain('folder not found')
  })

  it('also moves the open document so the breadcrumb follows', async () => {
    mockApi.documentMove.mockResolvedValue(meta('d1', 'a'))
    useDesignStore.setState({
      docs: [meta('d1')],
      docId: 'd1',
      doc: fullDoc(meta('d1')),
    })
    await useDesignStore.getState().moveDoc('d1', 'a')
    expect(useDesignStore.getState().doc?.folderId).toBe('a')
  })
})

describe('broadcasts', () => {
  it('bumps only the thumbnail version on design:thumbnail-updated', () => {
    useDesignStore.setState({ docs: [meta('d1'), meta('d2')] })
    useDesignStore.getState().startWatch()
    mockApi.documentsList.mockClear()

    handlers.thumbnailUpdated({ docId: 'd1', thumbnailVersion: 'v9' })
    const docs = useDesignStore.getState().docs
    expect(docs.find((d) => d.id === 'd1')?.thumbnailVersion).toBe('v9')
    expect(docs.find((d) => d.id === 'd2')?.thumbnailVersion).toBeNull()
    expect(mockApi.documentsList).not.toHaveBeenCalled()
  })

  it('patches the folder of a moved document without refetching it and reloads folders', async () => {
    useDesignStore.setState({ docs: [meta('d1')] })
    useDesignStore.getState().startWatch()

    handlers.documentUpdated({ docId: 'd1', folderId: 'a', moved: true })
    await flush()
    expect(useDesignStore.getState().docs[0].folderId).toBe('a')
    expect(mockApi.documentGet).not.toHaveBeenCalled()
    expect(mockApi.documentsList).not.toHaveBeenCalled()
    expect(mockApi.foldersList).toHaveBeenCalled()
  })

  it('reloads folders on design:folders-updated', async () => {
    useDesignStore.getState().startWatch()
    mockApi.foldersList.mockResolvedValue([folder('x', 3)])
    handlers.foldersUpdated({ folderId: 'x' })
    await flush()
    expect(useDesignStore.getState().folders[0].docCount).toBe(3)
  })
})

describe('hub view state', () => {
  it('remembers section and sort in localStorage', () => {
    useDesignStore.getState().setHubFolder('archived')
    useDesignStore.getState().setHubSort('name')
    expect(loadHubPrefs()).toEqual({ hubFolder: 'archived', hubSort: 'name' })
  })

  it('records the newest finish per document for the "novo" badge', () => {
    const finish = (at: number): DesignAgentActivity => ({
      docId: 'd1',
      artboardId: 'ab1',
      nodeIds: [],
      tool: 'design_nodes_finish',
      phase: 'finish',
      sessionId: 's1',
      at,
    })
    handleAgentActivity(useDesignStore, finish(50))
    handleAgentActivity(useDesignStore, finish(20))
    expect(useDesignStore.getState().lastFinishAt.d1).toBe(50)
  })

  it('archiving moves the doc into the archived list', async () => {
    mockApi.documentArchive.mockResolvedValue(fullDoc({ ...meta('d1'), status: 'archived' }))
    useDesignStore.setState({ docs: [meta('d1')] })
    await useDesignStore.getState().archiveDoc('d1')
    expect(useDesignStore.getState().docs).toEqual([])
    expect(useDesignStore.getState().archivedDocs.map((d) => d.id)).toEqual(['d1'])
  })
})
