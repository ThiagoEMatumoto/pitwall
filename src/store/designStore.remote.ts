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
import { recordFinish, reduceActivity, setDocActivity } from './designStore.live'

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
  if (evt.docId !== store.getState().docId) {
    touchDocMeta(store, evt.docId)
    return
  }
  const ab = store.getState().artboards[evt.artboardId]
  if (!ab) {
    // Claude created an artboard while this doc is open: the broadcast is the
    // only signal, so pull the fresh document and adopt it instead of waiting
    // for a remount.
    void adoptNewArtboard(store, evt.artboardId)
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

// A closed document only moves in the list: its tree is fetched when opened.
// The event has no timestamp; main stamped updatedAt at write time, so now is
// close enough for ordering.
function touchDocMeta(store: DesignStore, docId: string): void {
  store.setState((s) => {
    const meta = s.docs.find((d) => d.id === docId)
    return meta ? { docs: upsertMeta(s.docs, { ...meta, updatedAt: Date.now() }) } : {}
  })
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
  const current = store.getState().activityByDoc[a.docId] ?? {}
  setDocActivity(store, a.docId, reduceActivity(current, a))
  if (a.phase === 'finish') recordFinish(store, a)
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
      artboardToDelete: s.artboardToDelete === artboardId ? null : s.artboardToDelete,
      textEditing: s.textEditing?.artboardId === artboardId ? null : s.textEditing,
      previewArtboardId: s.previewArtboardId === artboardId ? null : s.previewArtboardId,
    }
  })
}
