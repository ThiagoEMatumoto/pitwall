// Handlers for the design:* broadcasts (main → renderer). Own file so the
// echo/version/resync rules read as one unit.

import { api } from '@/lib/ipc'
import type { ArtboardUpdatedEvent, DesignAgentActivity } from '@shared/types/design'
import {
  applyLocal,
  artboardsOf,
  bridges,
  bumpVersion,
  forgetArtboard,
  maybeToastRemoteUpdate,
  pendingNonces,
  toMeta,
  upsertMeta,
  type DesignStore,
} from './designStore.internal'

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
  if (evt.origin.kind === 'claude') {
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
  const fresh = artboardsOf(doc)[artboardId]
  if (!fresh) return
  store.setState((s) =>
    s.artboards[artboardId] ? {} : { doc, artboards: { ...s.artboards, [artboardId]: fresh } },
  )
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
    // 'end' replaces the matching 'start' so the overlay keeps one row per call.
    const list = s.agentActivity[key] ?? []
    const others = list.filter((x) => !(x.tool === a.tool && x.sessionId === a.sessionId))
    return { agentActivity: { ...s.agentActivity, [key]: [...others, a] } }
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
  store.setState((s) => ({
    doc,
    docs: upsertMeta(s.docs, toMeta(doc)),
    reloadNonce: s.reloadNonce + (needsReload ? 1 : 0),
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
