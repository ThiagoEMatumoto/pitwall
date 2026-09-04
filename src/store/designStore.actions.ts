// Store actions with bodies too long for the store definition: artboard
// creation, releasing a gesture that never committed, and the resync that
// follows a rejected write.

import { api } from '@/lib/ipc'
import { buildIndex } from '@shared/design/ops'
import type { ArtboardPreset, DesignArtboard } from '@shared/types/design'
import type { ArtboardPlacement } from '@/features/design/canvas/geometry'
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

const ARTBOARD_GAP = 100

// Without `placement` the artboard is parked to the right of the page;
// a frame drawn on the canvas brings its own box.
export async function createArtboardAction(
  store: DesignStore,
  preset: ArtboardPreset,
  placement?: ArtboardPlacement,
): Promise<DesignArtboard> {
  const { docId, pageId } = store.getState()
  if (!docId || !pageId) throw new Error('no document open')
  const existing = pageArtboards(store)
  const x = existing.length ? Math.max(...existing.map((m) => m.x + m.width)) + ARTBOARD_GAP : 0
  const box = placement ?? { x, y: 0, width: preset.width, height: preset.height }
  const artboard = await api.design.artboardCreate({
    docId,
    pageId,
    name: `${preset.label} ${existing.length + 1}`,
    width: box.width,
    height: box.height,
    sizing: preset.sizing,
    x: box.x,
    y: box.y,
  })
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
  return artboard
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
