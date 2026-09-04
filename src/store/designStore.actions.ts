// Store actions with bodies too long for the store definition: artboard
// creation/duplication/removal, releasing a gesture that never committed, and
// the resync that follows a rejected write.

import { api } from '@/lib/ipc'
import { nextArtboardX } from '@shared/design/artboard-layout'
import { buildIndex } from '@shared/design/ops'
import type { ArtboardPreset, DesignArtboard } from '@shared/types/design'
import {
  bridges,
  indexes,
  pageArtboards,
  setLocal,
  toMeta,
  transientBase,
  upsertMeta,
  type DesignStore,
} from './designStore.internal'
import { handleArtboardDeleted } from './designStore.remote'

// Puts a freshly created artboard on the canvas and selects it.
function adopt(store: DesignStore, artboard: DesignArtboard, pageId: string): void {
  indexes.set(artboard.id, buildIndex(artboard.tree))
  store.setState((s) => ({
    artboards: {
      ...s.artboards,
      [artboard.id]: {
        meta: artboard,
        tree: artboard.tree,
        version: artboard.version,
        ready: false,
      },
    },
    doc: s.doc
      ? {
          ...s.doc,
          pages: s.doc.pages.map((p) =>
            p.id === pageId ? { ...p, artboards: [...p.artboards, artboard] } : p,
          ),
        }
      : s.doc,
    selection: { artboardId: artboard.id, nodeIds: [] },
  }))
}

export async function createArtboardAction(
  store: DesignStore,
  preset: ArtboardPreset,
): Promise<DesignArtboard> {
  const { docId, pageId } = store.getState()
  if (!docId || !pageId) throw new Error('no document open')
  const existing = pageArtboards(store)
  const x = nextArtboardX(existing)
  const artboard = await api.design.artboardCreate({
    docId,
    pageId,
    name: `${preset.label} ${existing.length + 1}`,
    width: preset.width,
    height: preset.height,
    sizing: preset.sizing,
    x,
    y: 0,
  })
  adopt(store, artboard, pageId)
  return artboard
}

// The copy's position comes from the main process (next to the original).
export async function duplicateArtboardAction(
  store: DesignStore,
  artboardId: string,
): Promise<DesignArtboard> {
  const source = store.getState().artboards[artboardId]?.meta
  if (!source) throw new Error(`design artboard not found: ${artboardId}`)
  const artboard = await api.design.artboardDuplicate({
    artboardId,
    name: `${source.name} cópia`,
  })
  adopt(store, artboard, source.pageId)
  return artboard
}

// The broadcast would clean the local state too, but the sidebar should not
// wait a round trip to stop showing a row the user just deleted.
export async function deleteArtboardAction(store: DesignStore, artboardId: string): Promise<void> {
  await api.design.artboardDelete(artboardId)
  handleArtboardDeleted(store, artboardId)
}

// A gesture that never produced a final commit: what it painted is not on
// the server, so the canvas goes back to the last committed state.
export function releaseTransientAction(store: DesignStore, artboardId: string): void {
  const base = transientBase.get(artboardId)
  if (!base) return
  transientBase.delete(artboardId)
  const ab = store.getState().artboards[artboardId]
  if (!ab || (ab.tree === base.tree && ab.meta === base.meta)) return
  setLocal(store, artboardId, base.tree, base.meta)
  bridges.get(artboardId)?.reinit()
}

export async function resyncAction(store: DesignStore, artboardId: string): Promise<void> {
  const { docId } = store.getState()
  if (!docId) return
  const doc = await api.design.documentGet(docId)
  const fresh = doc?.pages.flatMap((p) => p.artboards).find((a) => a.id === artboardId)
  if (!doc || !fresh) return
  transientBase.delete(artboardId)
  store.setState((s) => ({ doc, docs: upsertMeta(s.docs, toMeta(doc)) }))
  setLocal(store, artboardId, fresh.tree, fresh, fresh.version)
  // The bridge's own getter (ArtboardFrame) reads the store just updated.
  bridges.get(artboardId)?.reinit()
}
