// Handlers for the design:* broadcasts (main → renderer). Own file so the
// echo/version/resync rules read as one unit.

import { api } from '@/lib/ipc'
import { artboardScreenRect, rectsIntersect } from '@/features/design/canvas/geometry'
import type {
  ArtboardUpdatedEvent,
  DesignAgentActivity,
  DesignArtboard,
} from '@shared/types/design'
import {
  applyLocal,
  artboardsOf,
  bridges,
  bumpVersion,
  forgetArtboard,
  maybeToastRemoteUpdate,
  pendingNonces,
  stageSize,
  toMeta,
  upsertMeta,
  type DesignStore,
} from './designStore.internal'

// The artboard's frame intersects the mounted stage on the current page. No
// stage (canvas not mounted) counts as not visible. A visible artboard already
// shows the in-place pill and the toolbar badge, so the "Claude atualizou" /
// "Claude terminou" toasts are only for one the human cannot see right now.
export function artboardInView(store: DesignStore, artboard: DesignArtboard): boolean {
  const { viewport, pageId } = store.getState()
  if (stageSize.w === 0 || stageSize.h === 0 || artboard.pageId !== pageId) return false
  const stage = { x: 0, y: 0, w: stageSize.w, h: stageSize.h }
  return rectsIntersect(artboardScreenRect(artboard, viewport), stage)
}

export function handleArtboardUpdated(store: DesignStore, evt: ArtboardUpdatedEvent): void {
  const ab = store.getState().artboards[evt.artboardId]
  if (!ab) {
    // Claude created an artboard while this doc is open: the broadcast is the
    // only signal, so pull the fresh document and adopt it instead of waiting
    // for a remount.
    if (evt.docId === store.getState().docId) void adoptNewArtboard(store, evt.artboardId)
    return
  }
  // My own write coming back: the tree already has it, only the version moves.
  if (pendingNonces.has(evt.origin.nonce)) {
    pendingNonces.delete(evt.origin.nonce)
    bumpVersion(store, evt.artboardId, evt.version)
    return
  }
  if (evt.version <= ab.version) return
  const contiguous = !evt.full && evt.version === ab.version + 1
  if (contiguous && applyLocal(store, evt.artboardId, evt.ops)) {
    bumpVersion(store, evt.artboardId, evt.version)
  } else {
    void store.getState().resync(evt.artboardId)
  }
  if (evt.origin.kind === 'claude' && !artboardInView(store, ab.meta)) {
    maybeToastRemoteUpdate(ab.meta, () => {
      store.getState().select(evt.artboardId, [])
      store.getState().fitToArtboard(evt.artboardId)
    })
  }
}

async function adoptNewArtboard(store: DesignStore, artboardId: string): Promise<void> {
  const docId = store.getState().docId
  if (!docId) return
  const doc = await api.design.documentGet(docId)
  if (!doc || store.getState().docId !== docId) return
  const fresh = artboardsOf(doc, (id) => id === artboardId)[artboardId]
  if (!fresh) return
  store.setState((s) =>
    s.artboards[artboardId] ? {} : { doc, artboards: { ...s.artboards, [artboardId]: fresh } },
  )
  if (artboardInView(store, fresh.meta)) return
  maybeToastRemoteUpdate(fresh.meta, () => {
    store.getState().select(artboardId, [])
    store.getState().fitToArtboard(artboardId)
  })
}

export function handleAgentActivity(store: DesignStore, a: DesignAgentActivity): void {
  if (a.docId !== store.getState().docId) return
  const key = a.artboardId ?? '*'
  store.setState((s) => {
    if (a.phase === 'finish') {
      if (a.artboardId === null) return { agentActivity: {} }
      const { [key]: _gone, ...rest } = s.agentActivity
      return { agentActivity: rest }
    }
    // 'end' replaces the matching 'start' so the overlay keeps one row per
    // call. A call may end on a different key than it started (an artboard
    // create starts at the document and ends on the artboard it made), so the
    // start is retired wherever it lives — else it veils every artboard until
    // it goes stale.
    const sameCall = (x: DesignAgentActivity) => x.tool === a.tool && x.sessionId === a.sessionId
    const next: Record<string, DesignAgentActivity[]> = {}
    for (const [k, list] of Object.entries(s.agentActivity)) {
      const kept = list.filter((x) => !(sameCall(x) && (k === key || x.phase === 'start')))
      if (kept.length) next[k] = kept
    }
    // Document-level writes are instantaneous and nothing waits for
    // design_nodes_finish on them (main clears them on 'end' too).
    if (a.phase === 'end' && a.artboardId === null) return { agentActivity: next }
    return { agentActivity: { ...next, [key]: [...(next[key] ?? []), a] } }
  })
}

export async function handleDocumentUpdated(store: DesignStore, docId: string): Promise<void> {
  if (docId !== store.getState().docId) {
    // Claude creating or renaming a document that is not open (the empty
    // state suggests exactly that) has to reach the DocsPanel list.
    await store.getState().loadDocs()
    return
  }
  const doc = await api.design.documentGet(docId)
  const prev = store.getState().doc
  if (!doc || !prev) return
  const needsReload =
    doc.globalCss !== prev.globalCss || JSON.stringify(doc.fonts) !== JSON.stringify(prev.fonts)
  // An artboard Claude created empty (design_artboard_create without html)
  // announces itself only through this broadcast: adopt it here.
  const known = store.getState().artboards
  const added = artboardsOf(doc, (id) => !known[id])
  store.setState((s) => ({
    doc,
    docs: upsertMeta(s.docs, toMeta(doc)),
    reloadNonce: s.reloadNonce + (needsReload ? 1 : 0),
    artboards: { ...s.artboards, ...added },
  }))
  for (const bridge of bridges.values()) bridge.setTokens(doc.tokens)
}

export function handleArtboardDeleted(store: DesignStore, artboardId: string): void {
  forgetArtboard(artboardId)
  store.setState((s) => {
    const { [artboardId]: _gone, ...artboards } = s.artboards
    const doc = s.doc
      ? {
          ...s.doc,
          pages: s.doc.pages.map((p) => ({
            ...p,
            artboards: p.artboards.filter((a) => a.id !== artboardId),
          })),
        }
      : s.doc
    return {
      artboards,
      doc,
      selection:
        s.selection.artboardId === artboardId ? { artboardId: null, nodeIds: [] } : s.selection,
      hover: s.hover?.artboardId === artboardId ? null : s.hover,
      textEditing: s.textEditing?.artboardId === artboardId ? null : s.textEditing,
      previewArtboardId: s.previewArtboardId === artboardId ? null : s.previewArtboardId,
    }
  })
}
