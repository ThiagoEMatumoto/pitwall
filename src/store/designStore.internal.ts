// Non-reactive module state of the design store plus the local-apply /
// send pipeline shared by commit, undo/redo and the remote handlers.
// Nothing here is rendered: indexes, bridges and undo stacks live outside
// Zustand on purpose (big, mutable, and never a render input).

import type { StoreApi } from 'zustand'
import { api } from '@/lib/ipc'
import { showToast } from '@/features/notifications/toast-store'
import { UndoHistory, type UndoEntry } from '@/features/design/undo'
import type { ArtboardBridge } from '@/features/design/canvas/runtime-bridge'
import type { Size } from '@/features/design/canvas/geometry'
import { applyOps, buildIndex, type ArtboardPatch, type IndexEntry } from '@shared/design/ops'
import { newNonce } from '@shared/design/ids'
import type {
  DesignArtboard,
  DesignDocument,
  DesignDocumentMeta,
  DesignNode,
  DesignOp,
} from '@shared/types/design'
import type { ArtboardState, CommitOptions, DesignState } from './designStore.types'

export type DesignStore = StoreApi<DesignState>

export const clientId: string = globalThis.crypto?.randomUUID?.() ?? newNonce()

export const indexes = new Map<string, Map<string, IndexEntry>>()
export const bridges = new Map<string, ArtboardBridge>()
export const history = new UndoHistory()
// Nonces of my own applyOps still to be echoed by design:artboard-updated.
export const pendingNonces = new Set<string>()
// Tree before the first transient op of a gesture; the final (non-transient)
// commit inverts against it so one Cmd+Z reverts the whole drag.
export const transientBase = new Map<string, { tree: DesignNode; meta: DesignArtboard }>()
// Serialises applyOps per artboard so each call carries the latest version.
const sendChains = new Map<string, Promise<void>>()
export let stageSize: Size = { w: 0, h: 0 }

const REMOTE_TOAST_THROTTLE_MS = 5000
const lastRemoteToastAt = new Map<string, number>()

export function getNodeIndex(artboardId: string): Map<string, IndexEntry> | undefined {
  return indexes.get(artboardId)
}

export function getBridge(artboardId: string): ArtboardBridge | undefined {
  return bridges.get(artboardId)
}

export function registerBridge(artboardId: string, bridge: ArtboardBridge): () => void {
  bridges.set(artboardId, bridge)
  return () => {
    if (bridges.get(artboardId) === bridge) bridges.delete(artboardId)
  }
}

export function setStageSize(size: Size): void {
  stageSize = size
}

export function canUndo(artboardId: string): boolean {
  return history.canUndo(artboardId)
}

export function canRedo(artboardId: string): boolean {
  return history.canRedo(artboardId)
}

export function resetLocalState(): void {
  history.clearAll()
  indexes.clear()
  transientBase.clear()
}

export function forgetArtboard(artboardId: string): void {
  indexes.delete(artboardId)
  history.clear(artboardId)
  transientBase.delete(artboardId)
}

// ---- pure helpers ----

export function maybeToastRemoteUpdate(artboard: DesignArtboard): void {
  const now = Date.now()
  if (now - (lastRemoteToastAt.get(artboard.id) ?? 0) < REMOTE_TOAST_THROTTLE_MS) return
  lastRemoteToastAt.set(artboard.id, now)
  showToast({ title: `Claude atualizou "${artboard.name}"` })
}

export function isVersionConflict(err: unknown): boolean {
  return err instanceof Error && err.message.includes('DESIGN_VERSION_CONFLICT')
}

export function metaPatch(meta: DesignArtboard): ArtboardPatch {
  return {
    x: meta.x,
    y: meta.y,
    width: meta.width,
    height: meta.height,
    name: meta.name,
  }
}

export function applyArtboardOps(meta: DesignArtboard, ops: readonly DesignOp[]): DesignArtboard {
  let next = meta
  for (const op of ops) if (op.type === 'setArtboard') next = { ...next, ...op.patch }
  return next
}

export function artboardsOf(doc: DesignDocument): Record<string, ArtboardState> {
  const out: Record<string, ArtboardState> = {}
  for (const page of doc.pages) {
    for (const ab of page.artboards) {
      out[ab.id] = {
        meta: ab,
        tree: ab.tree,
        version: ab.version,
        ready: false,
      }
      indexes.set(ab.id, buildIndex(ab.tree))
    }
  }
  return out
}

export function upsertMeta(list: DesignDocumentMeta[], meta: DesignDocumentMeta): DesignDocumentMeta[] {
  return [...list.filter((m) => m.id !== meta.id), meta].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function toMeta(doc: DesignDocument): DesignDocumentMeta {
  const { id, title, status, thumbnail, createdAt, updatedAt } = doc
  return { id, title, status, thumbnail, createdAt, updatedAt }
}

export function pageArtboards(store: DesignStore): DesignArtboard[] {
  const { artboards, pageId } = store.getState()
  return Object.values(artboards)
    .map((a) => a.meta)
    .filter((m) => m.pageId === pageId)
}

// ---- local apply + send pipeline ----

export function setLocal(
  store: DesignStore,
  artboardId: string,
  tree: DesignNode,
  meta: DesignArtboard,
  version?: number,
): void {
  indexes.set(artboardId, buildIndex(tree))
  store.setState((s) => {
    const ab = s.artboards[artboardId]
    if (!ab) return s
    return {
      artboards: {
        ...s.artboards,
        [artboardId]: { ...ab, tree, meta, version: version ?? ab.version },
      },
    }
  })
}

export function bumpVersion(store: DesignStore, artboardId: string, version: number): void {
  store.setState((s) => {
    const ab = s.artboards[artboardId]
    if (!ab || version <= ab.version) return s
    return { artboards: { ...s.artboards, [artboardId]: { ...ab, version } } }
  })
}

// Runs ops through the local copy and the iframe; false when the ops no
// longer fit the tree (target removed remotely).
export function applyLocal(store: DesignStore, artboardId: string, ops: DesignOp[]): boolean {
  const ab = store.getState().artboards[artboardId]
  if (!ab) return false
  let tree: DesignNode
  try {
    tree = applyOps(ab.tree, ops).tree
  } catch {
    return false
  }
  setLocal(store, artboardId, tree, applyArtboardOps(ab.meta, ops))
  const bridge = bridges.get(artboardId)
  if (bridge) {
    for (const op of ops) if (op.type === 'remove') bridge.dropRects(op.ids)
    void bridge.applyOps(ops).catch(() => undefined)
  }
  return true
}

export function sendOps(store: DesignStore, artboardId: string, ops: DesignOp[], opts: CommitOptions): void {
  const prev = sendChains.get(artboardId) ?? Promise.resolve()
  const next = prev.then(async () => {
    const ab = store.getState().artboards[artboardId]
    if (!ab) return
    const nonce = newNonce()
    pendingNonces.add(nonce)
    try {
      const evt = await api.design.artboardApplyOps({
        artboardId,
        ops,
        origin: { kind: 'human', sessionId: null, nonce },
        baseVersion: ab.version,
        snapshot: opts.snapshot,
        summary: opts.summary,
      })
      bumpVersion(store, artboardId, evt.version)
    } catch (err) {
      pendingNonces.delete(nonce)
      if (isVersionConflict(err)) {
        store.setState({ conflict: { artboardId } })
        await store.getState().resync(artboardId)
      } else {
        store.setState({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  })
  sendChains.set(artboardId, next)
}

export function applyHistoryEntry(
  store: DesignStore,
  artboardId: string,
  entry: UndoEntry,
  ops: DesignOp[],
): void {
  if (!applyLocal(store, artboardId, ops)) {
    history.discard(artboardId, entry)
    showToast({
      title: 'Não dá mais para desfazer: o elemento foi alterado por outra edição',
    })
    return
  }
  sendOps(store, artboardId, ops, {})
}
