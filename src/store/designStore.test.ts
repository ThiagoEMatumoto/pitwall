import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ArtboardUpdatedEvent,
  DesignArtboard,
  DesignDocument,
  DesignNode,
} from '@shared/types/design'

let updatedHandler: ((payload: unknown) => void) | null = null

const mockApi = {
  documentsList: vi.fn(),
  documentGet: vi.fn(),
  documentCreate: vi.fn(),
  documentUpdate: vi.fn(),
  pageUpdate: vi.fn().mockResolvedValue(undefined),
  artboardCreate: vi.fn(),
  artboardApplyOps: vi.fn(),
  selectionSet: vi.fn().mockResolvedValue(undefined),
  activeDocSet: vi.fn().mockResolvedValue(undefined),
  onArtboardUpdated: vi.fn((h: (payload: unknown) => void) => {
    updatedHandler = h
    return () => {
      updatedHandler = null
    }
  }),
  onAgentActivity: vi.fn(() => () => {}),
  onDocumentUpdated: vi.fn(() => () => {}),
  onArtboardDeleted: vi.fn(() => () => {}),
}

vi.mock('@/lib/ipc', () => ({ api: { design: mockApi } }))

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }))
vi.mock('@/features/notifications/toast-store', () => ({
  showToast: showToastMock,
}))

const { useDesignStore, registerBridge } = await import('./designStore')

type FakeBridge = {
  applyOps: ReturnType<typeof vi.fn>
  reinit: ReturnType<typeof vi.fn>
  dropRects: ReturnType<typeof vi.fn>
  init: ReturnType<typeof vi.fn>
  setTokens: ReturnType<typeof vi.fn>
}

function fakeBridge(opResult: { ok: boolean } | Error): FakeBridge {
  return {
    applyOps: vi.fn(() =>
      opResult instanceof Error ? Promise.reject(opResult) : Promise.resolve(opResult),
    ),
    reinit: vi.fn(),
    dropRects: vi.fn(),
    init: vi.fn(),
    setTokens: vi.fn(),
  }
}

function node(id: string, over: Partial<DesignNode> = {}): DesignNode {
  return {
    id,
    tag: 'div',
    kind: 'frame',
    style: {},
    attrs: {},
    children: [],
    ...over,
  }
}

function makeTree(): DesignNode {
  return node('root', {
    children: [
      node('a', {
        kind: 'text',
        tag: 'p',
        text: 'hello',
        style: { color: 'red' },
      }),
      node('b'),
    ],
  })
}

function makeArtboard(over: Partial<DesignArtboard> = {}): DesignArtboard {
  return {
    id: 'ab1',
    pageId: 'p1',
    name: 'Desktop 1',
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
    tree: makeTree(),
    version: 3,
    position: 0,
    createdAt: 1,
    updatedAt: 2,
    ...over,
  }
}

function makeDoc(artboard = makeArtboard()): DesignDocument {
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
        artboards: [artboard],
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  }
}

function updatedEvent(over: Partial<ArtboardUpdatedEvent> = {}): ArtboardUpdatedEvent {
  return {
    docId: 'doc1',
    artboardId: 'ab1',
    ops: [{ type: 'setText', id: 'a', text: 'from claude' }],
    version: 4,
    origin: { kind: 'claude', sessionId: 's1', nonce: 'remote-nonce' },
    full: false,
    ...over,
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('designStore', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockApi.documentGet.mockResolvedValue(makeDoc())
    mockApi.artboardApplyOps.mockImplementation(
      async (input: { baseVersion: number; origin: { nonce: string } }) => ({
        docId: 'doc1',
        artboardId: 'ab1',
        ops: [],
        version: input.baseVersion + 1,
        origin: { kind: 'human', sessionId: null, nonce: input.origin.nonce },
        full: false,
      }),
    )
    useDesignStore.getState().stopWatch()
    await useDesignStore.getState().openDoc('doc1')
    useDesignStore.getState().startWatch()
  })

  it('commit applies locally and calls artboardApplyOps with baseVersion', async () => {
    useDesignStore.getState().commit('ab1', [{ type: 'setText', id: 'a', text: 'bye' }])
    const ab = useDesignStore.getState().artboards.ab1
    expect(ab.tree.children[0].text).toBe('bye')
    await flush()
    expect(mockApi.artboardApplyOps).toHaveBeenCalledTimes(1)
    const input = mockApi.artboardApplyOps.mock.calls[0][0]
    expect(input.artboardId).toBe('ab1')
    expect(input.baseVersion).toBe(3)
    expect(input.origin.kind).toBe('human')
    expect(useDesignStore.getState().artboards.ab1.version).toBe(4)
  })

  it('echo of my own nonce only advances version, never reapplies', async () => {
    useDesignStore.getState().commit('ab1', [{ type: 'setText', id: 'a', text: 'mine' }])
    await flush()
    const nonce = mockApi.artboardApplyOps.mock.calls[0][0].origin.nonce
    updatedHandler!(
      updatedEvent({
        ops: [{ type: 'setText', id: 'a', text: 'stale echo' }],
        version: 4,
        origin: { kind: 'human', sessionId: null, nonce },
      }),
    )
    const ab = useDesignStore.getState().artboards.ab1
    expect(ab.tree.children[0].text).toBe('mine')
    expect(ab.version).toBe(4)
    expect(mockApi.documentGet).toHaveBeenCalledTimes(1)
    expect(showToastMock).not.toHaveBeenCalled()
  })

  it('remote version local+1 applies ops and toasts for claude', () => {
    updatedHandler!(updatedEvent())
    const ab = useDesignStore.getState().artboards.ab1
    expect(ab.tree.children[0].text).toBe('from claude')
    expect(ab.version).toBe(4)
    expect(showToastMock).toHaveBeenCalledTimes(1)
    expect(showToastMock.mock.calls[0][0].title).toContain('Desktop 1')
  })

  it('skipped version triggers resync from documentGet', async () => {
    const fresh = makeArtboard({
      version: 9,
      tree: node('root', { children: [node('z')] }),
    })
    mockApi.documentGet.mockResolvedValue(makeDoc(fresh))
    updatedHandler!(updatedEvent({ version: 6 }))
    await flush()
    expect(mockApi.documentGet).toHaveBeenCalledTimes(2)
    const ab = useDesignStore.getState().artboards.ab1
    expect(ab.version).toBe(9)
    expect(ab.tree.children.map((c) => c.id)).toEqual(['z'])
  })

  it('undo restores the tree deep-equal and redo reapplies', async () => {
    const before = useDesignStore.getState().artboards.ab1.tree
    useDesignStore.getState().commit('ab1', [{ type: 'remove', ids: ['a'] }])
    useDesignStore
      .getState()
      .commit('ab1', [{ type: 'setStyle', id: 'b', patch: { color: 'blue' } }])
    expect(useDesignStore.getState().artboards.ab1.tree.children).toHaveLength(1)
    useDesignStore.getState().undo('ab1')
    useDesignStore.getState().undo('ab1')
    expect(useDesignStore.getState().artboards.ab1.tree).toEqual(before)
    useDesignStore.getState().redo('ab1')
    expect(useDesignStore.getState().artboards.ab1.tree.children.map((c) => c.id)).toEqual(['b'])
    await flush()
    // 2 commits + 2 undos + 1 redo, each one IPC.
    expect(mockApi.artboardApplyOps).toHaveBeenCalledTimes(5)
  })

  it('a drag of transient ops plus one final commit is a single undo step', async () => {
    const before = useDesignStore.getState().artboards.ab1.tree
    useDesignStore
      .getState()
      .commit('ab1', [{ type: 'setStyle', id: 'b', patch: { left: '10px' } }], {
        transient: true,
      })
    useDesignStore
      .getState()
      .commit('ab1', [{ type: 'setStyle', id: 'b', patch: { left: '20px' } }], {
        transient: true,
      })
    useDesignStore
      .getState()
      .commit('ab1', [{ type: 'setStyle', id: 'b', patch: { left: '30px' } }])
    expect(useDesignStore.getState().artboards.ab1.tree.children[1].style.left).toBe('30px')
    useDesignStore.getState().undo('ab1')
    expect(useDesignStore.getState().artboards.ab1.tree).toEqual(before)
    await flush()
    expect(mockApi.artboardApplyOps).toHaveBeenCalledTimes(2)
  })

  it('DESIGN_VERSION_CONFLICT sets the conflict banner and resyncs', async () => {
    mockApi.artboardApplyOps.mockRejectedValueOnce(
      new Error('DESIGN_VERSION_CONFLICT: base 3, head 5'),
    )
    const fresh = makeArtboard({ version: 5 })
    mockApi.documentGet.mockResolvedValue(makeDoc(fresh))
    useDesignStore.getState().commit('ab1', [{ type: 'setText', id: 'a', text: 'late' }])
    await flush()
    expect(useDesignStore.getState().conflict).toEqual({ artboardId: 'ab1' })
    expect(useDesignStore.getState().artboards.ab1.version).toBe(5)
    expect(useDesignStore.getState().artboards.ab1.tree.children[0].text).toBe('hello')
  })

  it('after a conflict the queued sends are dropped and the undo history cleared', async () => {
    mockApi.artboardApplyOps.mockRejectedValueOnce(
      new Error('DESIGN_VERSION_CONFLICT: base 3, head 5'),
    )
    const fresh = makeArtboard({ version: 5 })
    mockApi.documentGet.mockResolvedValue(makeDoc(fresh))
    useDesignStore.getState().commit('ab1', [{ type: 'setText', id: 'a', text: 'A' }])
    useDesignStore.getState().commit('ab1', [{ type: 'setText', id: 'a', text: 'B' }])
    await flush()
    await flush()
    // Only A reached IPC; B was computed against a tree the server refused.
    expect(mockApi.artboardApplyOps).toHaveBeenCalledTimes(1)
    const ab = useDesignStore.getState().artboards.ab1
    expect(ab.version).toBe(5)
    expect(ab.tree.children[0].text).toBe('hello')
    const { canUndo } = await import('./designStore')
    expect(canUndo('ab1')).toBe(false)
  })

  it('a non-conflict IPC error also resyncs from the server', async () => {
    mockApi.artboardApplyOps.mockRejectedValueOnce(new Error('boom'))
    const fresh = makeArtboard({ version: 7 })
    mockApi.documentGet.mockResolvedValue(makeDoc(fresh))
    useDesignStore.getState().commit('ab1', [{ type: 'setText', id: 'a', text: 'lost' }])
    await flush()
    await flush()
    expect(useDesignStore.getState().error).toBe('boom')
    expect(useDesignStore.getState().conflict).toBeNull()
    expect(useDesignStore.getState().artboards.ab1.version).toBe(7)
    expect(useDesignStore.getState().artboards.ab1.tree.children[0].text).toBe('hello')
  })

  it('releaseTransient reverts a gesture that never committed and repaints the frame', async () => {
    const bridge = fakeBridge({ ok: true })
    const unregister = registerBridge('ab1', bridge as never)
    const before = useDesignStore.getState().artboards.ab1
    useDesignStore
      .getState()
      .commit('ab1', [{ type: 'setStyle', id: 'b', patch: { left: '10px' } }], {
        transient: true,
      })
    useDesignStore.getState().commit('ab1', [{ type: 'setArtboard', patch: { x: 50 } }], {
      transient: true,
    })
    expect(useDesignStore.getState().artboards.ab1.tree.children[1].style.left).toBe('10px')
    useDesignStore.getState().releaseTransient('ab1')
    const after = useDesignStore.getState().artboards.ab1
    expect(after.tree).toBe(before.tree)
    expect(after.meta).toBe(before.meta)
    expect(bridge.reinit).toHaveBeenCalledTimes(1)
    // Nothing went to IPC and the next commit inverts against the right base.
    await flush()
    expect(mockApi.artboardApplyOps).not.toHaveBeenCalled()
    useDesignStore
      .getState()
      .commit('ab1', [{ type: 'setStyle', id: 'b', patch: { left: '99px' } }])
    useDesignStore.getState().undo('ab1')
    expect(useDesignStore.getState().artboards.ab1.tree).toEqual(before.tree)
    unregister()
  })

  it('an op the runtime refuses triggers a re-init from the current tree', async () => {
    const bridge = fakeBridge({ ok: false })
    const unregister = registerBridge('ab1', bridge as never)
    useDesignStore.getState().commit('ab1', [{ type: 'setText', id: 'a', text: 'x' }])
    await flush()
    expect(bridge.applyOps).toHaveBeenCalledTimes(1)
    expect(bridge.reinit).toHaveBeenCalledTimes(1)
    unregister()
    const rejecting = fakeBridge(new Error('design runtime timeout'))
    const unregister2 = registerBridge('ab1', rejecting as never)
    useDesignStore.getState().commit('ab1', [{ type: 'setText', id: 'a', text: 'y' }])
    await flush()
    expect(rejecting.reinit).toHaveBeenCalledTimes(1)
    unregister2()
  })

  it('selection is mirrored to main debounced', async () => {
    vi.useFakeTimers()
    useDesignStore.getState().select('ab1', ['a'])
    useDesignStore.getState().select('ab1', ['a', 'b'])
    vi.advanceTimersByTime(200)
    vi.useRealTimers()
    expect(mockApi.selectionSet).toHaveBeenCalledTimes(1)
    expect(mockApi.selectionSet).toHaveBeenCalledWith({
      docId: 'doc1',
      artboardId: 'ab1',
      nodeIds: ['a', 'b'],
    })
  })
})
