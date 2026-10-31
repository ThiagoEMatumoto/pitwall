import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ArtboardUpdatedEvent,
  DesignAgentActivity,
  DesignArtboard,
  DesignDocument,
  DesignLiveState,
} from '@shared/types/design'

const mockApi = {
  documentsList: vi.fn(),
  documentGet: vi.fn(),
  activeDocSet: vi.fn().mockResolvedValue(undefined),
  selectionSet: vi.fn().mockResolvedValue(undefined),
  pageUpdate: vi.fn().mockResolvedValue(undefined),
  liveState: vi.fn(),
  onArtboardUpdated: vi.fn(() => () => {}),
  onAgentActivity: vi.fn(() => () => {}),
  onDocumentUpdated: vi.fn(() => () => {}),
  onArtboardDeleted: vi.fn(() => () => {}),
}

vi.mock('@/lib/ipc', () => ({ api: { design: mockApi } }))
vi.mock('@/features/notifications/toast-store', () => ({
  showToast: vi.fn(),
  dismissToast: vi.fn(),
}))

const { useDesignStore } = await import('./designStore')
const { handleAgentActivity, handleArtboardUpdated } = await import('./designStore.remote')

function artboard(id: string, version = 1): DesignArtboard {
  return {
    id,
    pageId: 'p1',
    name: id.toUpperCase(),
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    sizing: 'fixed',
    tree: { id: `${id}-root`, tag: 'div', kind: 'frame', style: {}, attrs: {}, children: [] },
    version,
    position: 0,
    createdAt: 1,
    updatedAt: 2,
  }
}

function doc(id: string, artboards: DesignArtboard[], updatedAt = 2): DesignDocument {
  return {
    id,
    title: id,
    status: 'active',
    folderId: null,
    thumbnailVersion: null,
    createdAt: 1,
    updatedAt,
    tokens: {},
    fonts: [],
    globalCss: '',
    links: [],
    pages: [
      {
        id: 'p1',
        documentId: id,
        name: 'Page 1',
        position: 0,
        viewport: { x: 0, y: 0, zoom: 1 },
        artboards,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  }
}

// Same fields, in the same order, as withActivity's emit()
// (electron/main/services/mcp/design-tools-shared.ts).
function start(docId: string, artboardId: string | null, at = Date.now()): DesignAgentActivity {
  return {
    docId,
    artboardId,
    nodeIds: artboardId ? [`${artboardId}-root`] : [],
    tool: 'design_write_html',
    phase: 'start',
    sessionId: 'mother-1',
    at,
  }
}

// Same fields as the 'finish' design_nodes_finish broadcasts and live-state
// records (electron/main/services/mcp/design-tools.ts).
function finish(docId: string, artboardId: string, at: number, summary: string): DesignAgentActivity {
  return {
    docId,
    artboardId,
    nodeIds: [],
    tool: 'design_nodes_finish',
    phase: 'finish',
    sessionId: 'mother-1',
    at,
    summary,
  }
}

function live(docId: string, over: Partial<DesignLiveState> = {}): DesignLiveState {
  return { docId, activity: [], changes: [], ...over }
}

const docs: Record<string, DesignDocument> = {
  docA: doc('docA', [artboard('a1')]),
  docB: doc('docB', [artboard('b1'), artboard('b2')]),
}

describe('designStore live state', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()
    mockApi.documentGet.mockImplementation(async (id: string) => docs[id] ?? null)
    mockApi.liveState.mockResolvedValue([])
    await useDesignStore.getState().closeDoc()
    useDesignStore.setState({
      activityByDoc: {},
      lastSeenAt: {},
      unseenChanges: [],
      docs: [docs.docA, docs.docB].map(
        ({ id, title, status, folderId, thumbnailVersion, createdAt, updatedAt }) => ({
          id,
          title,
          status,
          folderId,
          thumbnailVersion,
          createdAt,
          updatedAt,
        }),
      ),
    })
  })

  it('retains activity of a document that is not open', async () => {
    await useDesignStore.getState().openDoc('docA')
    handleAgentActivity(useDesignStore, start('docB', 'b1'))
    const s = useDesignStore.getState()
    expect(s.activityByDoc.docB?.b1).toHaveLength(1)
    // The open document's slice is untouched.
    expect(s.agentActivity).toEqual({})
    // Opening it later shows what is still in flight (main is authoritative).
    mockApi.liveState.mockResolvedValue([live('docB', { activity: [start('docB', 'b1')] })])
    await useDesignStore.getState().openDoc('docB')
    expect(useDesignStore.getState().agentActivity.b1?.[0].tool).toBe('design_write_html')
  })

  it('finish of a closed document clears only that document', async () => {
    await useDesignStore.getState().openDoc('docA')
    handleAgentActivity(useDesignStore, start('docA', 'a1'))
    handleAgentActivity(useDesignStore, start('docB', 'b1'))
    handleAgentActivity(useDesignStore, finish('docB', 'b1', Date.now(), 'done'))
    const s = useDesignStore.getState()
    expect(s.activityByDoc.docB).toBeUndefined()
    expect(s.agentActivity.a1).toHaveLength(1)
  })

  it('openDoc hydrates activity and unseen changes from design:live-state', async () => {
    useDesignStore.setState({ lastSeenAt: { docB: 1000 } })
    mockApi.liveState.mockResolvedValue([
      live('docB', {
        activity: [start('docB', 'b2', 1500), start('docB', null, 1600)],
        changes: [finish('docB', 'b1', 900, 'old pass'), finish('docB', 'b1', 1200, 'hero copy')],
      }),
    ])
    await useDesignStore.getState().openDoc('docB')
    expect(mockApi.liveState).toHaveBeenCalledWith('docB')
    const s = useDesignStore.getState()
    expect(Object.keys(s.agentActivity).sort()).toEqual(['*', 'b2'])
    expect(s.activityByDoc.docB).toBe(s.agentActivity)
    expect(s.unseenChanges.map((c) => c.summary)).toEqual(['hero copy'])
  })

  it('markSeen empties the list and persists lastSeenAt', async () => {
    mockApi.liveState.mockResolvedValue([
      live('docB', { changes: [finish('docB', 'b1', Date.now(), 'hero copy')] }),
    ])
    await useDesignStore.getState().openDoc('docB')
    expect(useDesignStore.getState().unseenChanges).toHaveLength(1)
    useDesignStore.getState().markSeen('docB')
    expect(useDesignStore.getState().unseenChanges).toEqual([])
    const stored = JSON.parse(localStorage.getItem('pitwall.design.lastSeenAt') ?? '{}')
    expect(stored.docB).toBe(useDesignStore.getState().lastSeenAt.docB)
  })

  it('switching documents marks the previous one as seen', async () => {
    await useDesignStore.getState().openDoc('docA')
    await useDesignStore.getState().openDoc('docB')
    expect(useDesignStore.getState().lastSeenAt.docA).toBeGreaterThan(0)
    expect(useDesignStore.getState().lastSeenAt.docB).toBeUndefined()
  })

  it('hydrating every document replaces stale activity of closed ones', async () => {
    await useDesignStore.getState().openDoc('docA')
    handleAgentActivity(useDesignStore, start('docB', 'b1'))
    mockApi.liveState.mockResolvedValue([live('docA', { activity: [start('docA', 'a1')] })])
    await useDesignStore.getState().hydrateLive()
    expect(mockApi.liveState).toHaveBeenLastCalledWith(undefined)
    const s = useDesignStore.getState()
    expect(s.activityByDoc.docB).toBeUndefined()
    expect(s.agentActivity.a1).toHaveLength(1)
  })

  it('an artboard update of a closed document bumps its meta in the list', async () => {
    await useDesignStore.getState().openDoc('docA')
    const evt: ArtboardUpdatedEvent = {
      docId: 'docB',
      artboardId: 'b1',
      ops: [],
      version: 2,
      origin: { kind: 'claude', sessionId: 'mother-1', nonce: 'n1' },
      full: false,
    }
    const before = Date.now()
    handleArtboardUpdated(useDesignStore, evt)
    const s = useDesignStore.getState()
    expect(s.docs[0].id).toBe('docB')
    expect(s.docs[0].updatedAt).toBeGreaterThanOrEqual(before)
    // Nothing of docB leaks into the open canvas.
    expect(Object.keys(s.artboards)).toEqual(['a1'])
    expect(mockApi.documentGet).toHaveBeenCalledTimes(1)
  })

  it('resyncDoc refetches the open document, adopting and dropping artboards', async () => {
    await useDesignStore.getState().openDoc('docB')
    const changed = { ...artboard('b1', 5), name: 'B1 novo' }
    mockApi.documentGet.mockResolvedValueOnce(doc('docB', [changed, artboard('b3')]))
    await useDesignStore.getState().resyncDoc()
    const s = useDesignStore.getState()
    expect(Object.keys(s.artboards).sort()).toEqual(['b1', 'b3'])
    expect(s.artboards.b1.version).toBe(5)
    expect(s.artboards.b1.meta.name).toBe('B1 novo')
  })
})
