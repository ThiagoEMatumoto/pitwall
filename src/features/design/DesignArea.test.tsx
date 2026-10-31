import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignDocument } from '@shared/types/design'

const mockApi = {
  documentsList: vi.fn().mockResolvedValue([]),
  documentGet: vi.fn(),
  activeDocSet: vi.fn().mockResolvedValue(undefined),
  selectionSet: vi.fn().mockResolvedValue(undefined),
  pageUpdate: vi.fn().mockResolvedValue(undefined),
  liveState: vi.fn().mockResolvedValue([]),
  onArtboardUpdated: vi.fn(() => () => {}),
  onAgentActivity: vi.fn(() => () => {}),
  onDocumentUpdated: vi.fn(() => () => {}),
  onArtboardDeleted: vi.fn(() => () => {}),
  onDocumentDeleted: vi.fn(() => () => {}),
  onFoldersUpdated: vi.fn(() => () => {}),
  onThumbnailUpdated: vi.fn(() => () => {}),
  foldersList: vi.fn().mockResolvedValue([]),
}
vi.mock('@/lib/ipc', () => ({ api: { design: mockApi } }))
vi.mock('@/features/notifications/toast-store', () => ({
  showToast: vi.fn(),
  dismissToast: vi.fn(),
}))

// The area's own effect is under test; the panels and canvas are not.
const none = () => null
vi.mock('./ask-claude/AskClaudeComposer', () => ({ AskClaudeComposer: none }))
vi.mock('./canvas/CanvasStage', () => ({ CanvasStage: none }))
vi.mock('./canvas/ChangesSinceVisit', () => ({ ChangesSinceVisit: none }))
vi.mock('./canvas/useCanvasShortcuts', () => ({ useCanvasShortcuts: () => undefined }))
vi.mock('./DeleteArtboardDialog', () => ({ DeleteArtboardDialog: none }))
vi.mock('./DesignToolbar', () => ({ DesignToolbar: none }))
vi.mock('./hub/DesignHub', () => ({ DesignHub: none }))
vi.mock('./inspector/Inspector', () => ({ Inspector: none }))
vi.mock('./preview/PreviewMode', () => ({ PreviewMode: none }))
vi.mock('./ShortcutsPanel', () => ({ ShortcutsPanel: none }))
vi.mock('./sidebar/DesignBreadcrumb', () => ({ DesignBreadcrumb: none }))
vi.mock('./sidebar/DocsPanel', () => ({ DocsPanel: none }))
vi.mock('./sidebar/LayersPanel', () => ({ LayersPanel: none }))

const { useDesignStore } = await import('@/store/designStore')
const { DesignArea } = await import('./DesignArea')

function makeDoc(version: number): DesignDocument {
  return {
    id: 'doc1',
    title: 'Landing',
    status: 'active',
    thumbnail: null,
    createdAt: 1,
    updatedAt: 2,
    tokens: {},
    fonts: [],
    globalCss: '',
    links: [],
    pages: [
      {
        id: 'p1',
        documentId: 'doc1',
        name: 'Page 1',
        position: 0,
        viewport: { x: 0, y: 0, zoom: 1 },
        artboards: [
          {
            id: 'ab1',
            pageId: 'p1',
            name: 'Home',
            x: 0,
            y: 0,
            width: 800,
            height: 600,
            sizing: 'fixed',
            tree: { id: 'root', tag: 'div', kind: 'frame', style: {}, attrs: {}, children: [] },
            version,
            position: 0,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('DesignArea remount', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refetches the document left open while the area was away', async () => {
    mockApi.documentGet.mockResolvedValue(makeDoc(3))
    await useDesignStore.getState().openDoc('doc1')
    mockApi.documentGet.mockClear()
    mockApi.liveState.mockClear()

    // Claude kept writing while the human was in another area.
    mockApi.documentGet.mockResolvedValue(makeDoc(7))
    const view = render(<DesignArea />)
    await flush()

    expect(mockApi.documentGet).toHaveBeenCalledWith('doc1')
    expect(mockApi.liveState).toHaveBeenCalledWith(undefined)
    expect(useDesignStore.getState().artboards.ab1.version).toBe(7)

    view.unmount()
    // Leaving after the hydration counts as having seen the document.
    expect(useDesignStore.getState().lastSeenAt.doc1).toBeGreaterThan(0)
  })

  it('does not refetch a document when none is open', async () => {
    await useDesignStore.getState().closeDoc()
    mockApi.documentGet.mockClear()
    const view = render(<DesignArea />)
    await flush()
    expect(mockApi.documentGet).not.toHaveBeenCalled()
    expect(mockApi.liveState).toHaveBeenCalledWith(undefined)
    view.unmount()
  })
})
