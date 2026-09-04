import { create } from 'zustand'
import { api } from '@/lib/ipc'
import { centerViewport, fitViewport, unionRects, zoomAt } from '@/features/design/canvas/geometry'
import { scopeAfterSelect } from '@/features/design/canvas/scope-path'
import { invertOps } from '@shared/design/ops'
import type { ArtboardUpdatedEvent, DesignAgentActivity, DesignOp } from '@shared/types/design'
import type { DesignState } from './designStore.types'
import {
  applyHistoryEntry,
  applyLocal,
  artboardsOf,
  bridges,
  history,
  indexes,
  metaPatch,
  pageArtboards,
  reportFlowHeightAction,
  resetLocalState,
  selectionBounds,
  sendOps,
  stageSize,
  toMeta,
  transientBase,
  upsertMeta,
} from './designStore.internal'
import { createArtboardAction, releaseTransientAction, resyncAction } from './designStore.actions'
import {
  handleAgentActivity,
  handleArtboardDeleted,
  handleArtboardUpdated,
  handleDocumentUpdated,
} from './designStore.remote'

export type {
  ArtboardState,
  CanvasSelection,
  CommitOptions,
  DesignState,
  DesignTool,
  HoverState,
  TextEditEnd,
} from './designStore.types'
export {
  canRedo,
  canUndo,
  clientId,
  getBridge,
  getNodeIndex,
  registerBridge,
  setStageSize,
} from './designStore.internal'

const SELECTION_DEBOUNCE_MS = 150
const VIEWPORT_PERSIST_MS = 500
// A small node framed alone may zoom in this far (artboards stop at 100%).
const SELECTION_MAX_ZOOM = 4

function ancestorIds(artboardId: string | null, nodeId: string): string[] {
  const index = artboardId ? indexes.get(artboardId) : undefined
  const ids: string[] = []
  let cur = index?.get(nodeId)?.parentId ?? null
  while (cur) {
    ids.push(cur)
    cur = index?.get(cur)?.parentId ?? null
  }
  return ids
}

const EMPTY_SELECTION = { artboardId: null, nodeIds: [] as string[] }

let selectionTimer: ReturnType<typeof setTimeout> | null = null
let viewportTimer: ReturnType<typeof setTimeout> | null = null
// StrictMode-safe: the second startWatch() is a no-op.
let watchStarted = false
let offs: Array<() => void> = []

export const useDesignStore = create<DesignState>((set, get, store) => {
  const scheduleViewportPersist = (): void => {
    if (viewportTimer) clearTimeout(viewportTimer)
    viewportTimer = setTimeout(() => {
      viewportTimer = null
      const { pageId, viewport } = get()
      if (pageId) void api.design.pageUpdate({ id: pageId, viewport }).catch(() => undefined)
    }, VIEWPORT_PERSIST_MS)
  }

  return {
    docs: [],
    docId: null,
    doc: null,
    pageId: null,
    artboards: {},
    selection: EMPTY_SELECTION,
    scopeId: null,
    hover: null,
    tool: 'move',
    viewport: { x: 0, y: 0, zoom: 1 },
    textEditing: null,
    agentActivity: {},
    conflict: null,
    loading: false,
    error: null,
    previewArtboardId: null,
    mode: 'edit',
    interaction: false,
    askOpen: false,
    reloadNonce: 0,
    lockedIds: {},

    loadDocs: async (filter) => {
      set({ loading: true, error: null })
      try {
        const docs = await api.design.documentsList(filter ?? { status: 'active' })
        set({ docs, loading: false })
      } catch (err) {
        set({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },

    openDoc: async (docId) => {
      set({ loading: true, error: null })
      const doc = await api.design.documentGet(docId)
      if (!doc) {
        set({ loading: false, error: 'Documento não encontrado' })
        return
      }
      resetLocalState()
      const page = doc.pages[0] ?? null
      set({
        docId,
        doc,
        pageId: page?.id ?? null,
        artboards: artboardsOf(doc),
        selection: EMPTY_SELECTION,
        scopeId: null,
        hover: null,
        textEditing: null,
        agentActivity: {},
        conflict: null,
        viewport: page?.viewport ?? { x: 0, y: 0, zoom: 1 },
        previewArtboardId: null,
        mode: 'edit',
        interaction: false,
        loading: false,
      })
      await api.design.activeDocSet(docId)
    },

    closeDoc: async () => {
      resetLocalState()
      set({
        docId: null,
        doc: null,
        pageId: null,
        artboards: {},
        selection: EMPTY_SELECTION,
        conflict: null,
      })
      await api.design.activeDocSet(null)
    },

    selectPage: (pageId) => {
      const page = get().doc?.pages.find((p) => p.id === pageId)
      if (!page) return
      set({
        pageId,
        viewport: page.viewport,
        selection: EMPTY_SELECTION,
        scopeId: null,
        hover: null,
      })
    },

    createDoc: async (title) => {
      const doc = await api.design.documentCreate({ title })
      set((s) => ({ docs: upsertMeta(s.docs, toMeta(doc)) }))
      await get().openDoc(doc.id)
      return doc
    },

    renameDoc: async (title) => {
      const { docId } = get()
      if (!docId) return
      const doc = await api.design.documentUpdate({ id: docId, title })
      set((s) => ({ doc, docs: upsertMeta(s.docs, toMeta(doc)) }))
    },

    archiveDoc: async (docId) => {
      await api.design.documentArchive(docId)
      set((s) => ({ docs: s.docs.filter((d) => d.id !== docId) }))
      if (get().docId === docId) await get().closeDoc()
    },

    createPage: async (name) => {
      const { docId, doc } = get()
      if (!docId || !doc) return
      const page = await api.design.pageCreate({ docId, name })
      set({ doc: { ...doc, pages: [...doc.pages, { ...page, artboards: page.artboards ?? [] }] } })
      get().selectPage(page.id)
    },

    createArtboard: (preset) => createArtboardAction(store, preset),

    updateArtboardMeta: (artboardId, patch) => {
      get().commit(artboardId, [{ type: 'setArtboard', patch }], {
        coalesceKey: `artboard:${artboardId}`,
      })
    },

    reportFlowHeight: (artboardId, height) => reportFlowHeightAction(store, artboardId, height),

    setArtboardReady: (artboardId, ready) => {
      set((s) => {
        const ab = s.artboards[artboardId]
        if (!ab || ab.ready === ready) return s
        return {
          artboards: { ...s.artboards, [artboardId]: { ...ab, ready } },
        }
      })
    },

    commit: (artboardId, ops, opts = {}) => {
      const ab = get().artboards[artboardId]
      if (!ab || ops.length === 0) return
      if (opts.transient && !transientBase.has(artboardId)) {
        transientBase.set(artboardId, { tree: ab.tree, meta: ab.meta })
      }
      const base = transientBase.get(artboardId) ?? {
        tree: ab.tree,
        meta: ab.meta,
      }
      let inverse: DesignOp[]
      try {
        inverse = invertOps(base.tree, ops, metaPatch(base.meta))
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
        return
      }
      if (!applyLocal(store, artboardId, ops)) return
      if (opts.transient) return
      transientBase.delete(artboardId)
      history.push(artboardId, { ops, inverse, coalesceKey: opts.coalesceKey })
      if (!opts.coalesceKey) history.seal(artboardId)
      sendOps(store, artboardId, ops, opts)
    },

    releaseTransient: (artboardId) => releaseTransientAction(store, artboardId),

    resync: (artboardId) => resyncAction(store, artboardId),

    dismissConflict: () => set({ conflict: null }),

    undo: (artboardId) => {
      history.seal(artboardId)
      const entry = history.popUndo(artboardId)
      if (entry) applyHistoryEntry(store, artboardId, entry, entry.inverse)
    },

    redo: (artboardId) => {
      const entry = history.popRedo(artboardId)
      if (entry) applyHistoryEntry(store, artboardId, entry, entry.ops)
    },

    // Selecting outside the current scope leaves it: the scope is only kept
    // while every selected node still lives inside it.
    select: (artboardId, nodeIds = []) =>
      set((s) => ({
        selection: { artboardId, nodeIds },
        scopeId: scopeAfterSelect(s.scopeId, nodeIds, (id) => ancestorIds(artboardId, id)),
      })),
    setScope: (scopeId) => set({ scopeId }),
    setHover: (hover) => set({ hover }),
    setTool: (tool) => set({ tool }),

    setViewport: (viewport) => {
      set({ viewport })
      scheduleViewportPersist()
    },

    zoomTo: (zoom, anchor) => {
      const point = anchor ?? { x: stageSize.w / 2, y: stageSize.h / 2 }
      get().setViewport(zoomAt(get().viewport, zoom, point))
    },

    fitToContent: () => {
      const bounds = unionRects(
        pageArtboards(store).map((m) => ({
          x: m.x,
          y: m.y,
          w: m.width,
          h: m.height,
        })),
      )
      if (!bounds || stageSize.w === 0) return
      get().setViewport(fitViewport(bounds, stageSize))
    },

    fitToArtboard: (artboardId) => {
      const m = get().artboards[artboardId]?.meta
      if (!m || stageSize.w === 0) return
      get().setViewport(fitViewport({ x: m.x, y: m.y, w: m.width, h: m.height }, stageSize))
    },

    fitToSelection: async (zoom) => {
      if (stageSize.w === 0) return
      const bounds = await selectionBounds(store)
      if (!bounds) {
        if (zoom === undefined) get().fitToContent()
        else get().zoomTo(zoom)
        return
      }
      get().setViewport(
        zoom === undefined
          ? fitViewport(bounds, stageSize, 64, SELECTION_MAX_ZOOM)
          : centerViewport(bounds, stageSize, zoom),
      )
    },

    toggleLock: (nodeId) =>
      set((s) => {
        const next = { ...s.lockedIds }
        if (next[nodeId]) delete next[nodeId]
        else next[nodeId] = true
        return { lockedIds: next }
      }),

    startTextEdit: (artboardId, nodeId) => {
      set({
        textEditing: { artboardId, nodeId },
        selection: { artboardId, nodeIds: [nodeId] },
      })
      bridges.get(artboardId)?.startTextEdit(nodeId)
    },

    endTextEdit: (result) => {
      const editing = get().textEditing
      set({ textEditing: null })
      if (!editing || !result || result.reason === 'escape') return
      const node = indexes.get(editing.artboardId)?.get(editing.nodeId)?.node
      if (!node || (node.text ?? '') === result.text) return
      get().commit(editing.artboardId, [{ type: 'setText', id: editing.nodeId, text: result.text }])
    },

    setTokens: async (tokens) => {
      const { docId } = get()
      if (!docId) return
      const doc = await api.design.documentUpdate({ id: docId, tokens })
      set({ doc })
      for (const bridge of bridges.values()) bridge.setTokens(doc.tokens)
    },

    startPreview: (artboardId) =>
      set({
        mode: 'preview',
        previewArtboardId: artboardId,
        textEditing: null,
        interaction: false,
      }),
    navigatePreview: (artboardId) => set({ previewArtboardId: artboardId }),
    exitPreview: () => set({ mode: 'edit', previewArtboardId: null, interaction: false }),
    setInteraction: (on) =>
      set((s) => (s.interaction === on ? s : { interaction: on, textEditing: null, hover: null })),
    setAskOpen: (askOpen) => set({ askOpen }),

    startWatch: () => {
      if (watchStarted) return
      watchStarted = true
      offs = [
        api.design.onArtboardUpdated((payload) => {
          const evt = payload as ArtboardUpdatedEvent
          if (evt?.artboardId) handleArtboardUpdated(store, evt)
        }),
        api.design.onAgentActivity((payload) => {
          const a = payload as DesignAgentActivity
          if (a?.docId) handleAgentActivity(store, a)
        }),
        api.design.onDocumentUpdated((payload) => {
          const { docId } = (payload ?? {}) as { docId?: string }
          if (docId) void handleDocumentUpdated(store, docId)
        }),
        api.design.onArtboardDeleted((payload) => {
          const { artboardId } = (payload ?? {}) as { artboardId?: string }
          if (artboardId) handleArtboardDeleted(store, artboardId)
        }),
      ]
    },

    stopWatch: () => {
      for (const off of offs) off()
      offs = []
      watchStarted = false
    },
  }
})

// Selection mirrors into main's live-state (design_selection_get), debounced.
useDesignStore.subscribe((s, prev) => {
  if (s.selection === prev.selection && s.docId === prev.docId) return
  if (selectionTimer) clearTimeout(selectionTimer)
  selectionTimer = setTimeout(() => {
    selectionTimer = null
    const { docId, selection } = useDesignStore.getState()
    if (!docId) return
    void api.design
      .selectionSet({
        docId,
        artboardId: selection.artboardId,
        nodeIds: selection.nodeIds,
      })
      .catch(() => undefined)
  }, SELECTION_DEBOUNCE_MS)
})
