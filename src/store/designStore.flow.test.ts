// Flow artboards: the measured height moves the local frame at once and is
// persisted quietly (coalesced, no undo, no snapshot, no baseVersion).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtboardUpdatedEvent, DesignArtboard, DesignDocument } from '@shared/types/design'

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
vi.mock('@/features/notifications/toast-store', () => ({
  showToast: vi.fn(),
  dismissToast: vi.fn(),
}))

const { useDesignStore, canUndo, registerBridge } = await import('./designStore')
const { FLOW_HEIGHT_PERSIST_MS, cancelHumanSnapshots, cancelFlowHeightPersists } =
  await import('./designStore.internal')

function makeArtboard(over: Partial<DesignArtboard> = {}): DesignArtboard {
  return {
    id: 'ab1',
    pageId: 'p1',
    name: 'Landing 1',
    x: 0,
    y: 0,
    width: 1440,
    height: 600,
    sizing: 'flow',
    tree: {
      id: 'root',
      tag: 'div',
      kind: 'frame',
      style: {},
      attrs: {},
      children: [],
    },
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

function fakeBridge() {
  return {
    applyOps: vi.fn(() => Promise.resolve({ ok: true })),
    reinit: vi.fn(),
    dropRects: vi.fn(),
    init: vi.fn(),
    setTokens: vi.fn(),
  }
}

const state = () => useDesignStore.getState()
const meta = () => state().artboards.ab1.meta

describe('reportFlowHeight', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    cancelHumanSnapshots()
    cancelFlowHeightPersists()
    mockApi.documentGet.mockResolvedValue(makeDoc())
    let version = 3
    mockApi.artboardApplyOps.mockImplementation(async (input: { origin: { nonce: string } }) => ({
      docId: 'doc1',
      artboardId: 'ab1',
      ops: [],
      version: ++version,
      origin: { kind: 'human', sessionId: null, nonce: input.origin.nonce },
      full: false,
    }))
    state().stopWatch()
    await state().openDoc('doc1')
    state().startWatch()
  })

  it('moves the local height at once, without touching the runtime or the history', () => {
    const bridge = fakeBridge()
    registerBridge('ab1', bridge as never)
    state().reportFlowHeight('ab1', 2340.4)
    expect(meta().height).toBe(2340)
    expect(bridge.applyOps).not.toHaveBeenCalled()
    expect(canUndo('ab1')).toBe(false)
    expect(mockApi.artboardApplyOps).not.toHaveBeenCalled()
  })

  it('persists once after the content settles, quietly', async () => {
    state().reportFlowHeight('ab1', 1800)
    state().reportFlowHeight('ab1', 2100)
    state().reportFlowHeight('ab1', 2340)
    await vi.advanceTimersByTimeAsync(FLOW_HEIGHT_PERSIST_MS - 1)
    expect(mockApi.artboardApplyOps).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mockApi.artboardApplyOps).toHaveBeenCalledTimes(1)
    const input = mockApi.artboardApplyOps.mock.calls[0][0]
    expect(input.ops).toEqual([{ type: 'setArtboard', patch: { height: 2340 } }])
    expect(input.snapshot).toBe(false)
    expect(input.baseVersion).toBeUndefined()
    expect(state().artboards.ab1.version).toBe(4)
    // No human snapshot follows a quiet write.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockApi.artboardApplyOps).toHaveBeenCalledTimes(1)
  })

  it('ignores sub-pixel changes, the flow minimum and fixed artboards', () => {
    state().reportFlowHeight('ab1', 600.4)
    expect(meta().height).toBe(600)
    state().reportFlowHeight('ab1', 20)
    expect(meta().height).toBe(200)
    state().updateArtboardMeta('ab1', { sizing: 'fixed' })
    state().reportFlowHeight('ab1', 5000)
    expect(meta().height).toBe(200)
  })

  it('the echo of its own persist only bumps the version; a remote height is adopted', async () => {
    state().reportFlowHeight('ab1', 2340)
    await vi.advanceTimersByTimeAsync(FLOW_HEIGHT_PERSIST_MS)
    const nonce = mockApi.artboardApplyOps.mock.calls[0][0].origin.nonce
    const echo: ArtboardUpdatedEvent = {
      docId: 'doc1',
      artboardId: 'ab1',
      ops: [{ type: 'setArtboard', patch: { height: 2340 } }],
      version: 4,
      origin: { kind: 'human', sessionId: null, nonce },
      full: false,
    }
    updatedHandler!(echo)
    expect(meta().height).toBe(2340)
    expect(mockApi.artboardApplyOps).toHaveBeenCalledTimes(1)
    updatedHandler!({
      ...echo,
      ops: [{ type: 'setArtboard', patch: { height: 3000 } }],
      version: 5,
      origin: { kind: 'claude', sessionId: 's1', nonce: 'other' },
    })
    expect(meta().height).toBe(3000)
    expect(state().artboards.ab1.version).toBe(5)
    await vi.advanceTimersByTimeAsync(FLOW_HEIGHT_PERSIST_MS * 2)
    expect(mockApi.artboardApplyOps).toHaveBeenCalledTimes(1)
  })
})

describe('interaction', () => {
  beforeEach(async () => {
    vi.useRealTimers()
    mockApi.documentGet.mockResolvedValue(makeDoc())
    await state().openDoc('doc1')
  })

  it('is left by preview and by exitPreview', () => {
    state().setInteraction(true)
    expect(state().interaction).toBe(true)
    state().startPreview('ab1')
    expect(state().interaction).toBe(false)
    state().setInteraction(true)
    state().exitPreview()
    expect(state().interaction).toBe(false)
  })
})
