// Handlers for the design:* broadcasts (main → renderer). Own file so the
// echo/version/resync rules read as one unit.

import { api } from '@/lib/ipc'
import type { ArtboardUpdatedEvent, DesignAgentActivity } from '@shared/types/design'
import {
  applyLocal,
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
  if (!ab) return
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
  if (evt.origin.kind === 'claude') maybeToastRemoteUpdate(ab.meta)
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
  if (docId !== store.getState().docId) return
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
      selection: s.selection.artboardId === artboardId ? { artboardId: null, nodeIds: [] } : s.selection,
      hover: s.hover?.artboardId === artboardId ? null : s.hover,
      textEditing: s.textEditing?.artboardId === artboardId ? null : s.textEditing,
      previewArtboardId: s.previewArtboardId === artboardId ? null : s.previewArtboardId,
    }
  })
}
