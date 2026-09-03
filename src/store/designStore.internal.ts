// Non-reactive module state of the design store plus the local-apply /
// send pipeline shared by commit, undo/redo and the remote handlers.
// Nothing here is rendered: indexes, bridges and undo stacks live outside
// Zustand on purpose (big, mutable, and never a render input).

import type { StoreApi } from 'zustand'
import { api } from '@/lib/ipc'
import { showToast } from '@/features/notifications/toast-store'
import { showAgentToast } from '@/features/design/design-toasts'
import { UndoHistory, type UndoEntry } from '@/features/design/undo'
import type { ArtboardBridge } from '@/features/design/canvas/runtime-bridge'
import { unionRects, type Size } from '@/features/design/canvas/geometry'
import type { Rect } from '@shared/design/protocol'
import { applyOps, buildIndex, type ArtboardPatch, type IndexEntry } from '@shared/design/ops'
import { newNonce } from '@shared/design/ids'
import { MIN_FLOW_HEIGHT_PX, clampArtboardSize } from '@shared/design/safety'
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
// Bumped when a send fails: sends queued before the failure are dropped, since
// the resync replaces the local tree they were computed against.
const sendEpochs = new Map<string, number>()
export let stageSize: Size = { w: 0, h: 0 }

const REMOTE_TOAST_THROTTLE_MS = 5000
const lastRemoteToastAt = new Map<string, number>()
// Human edits do not snapshot per op (a drag is one op, a colour scrub is
// one op...). Once a burst of edits goes quiet, the head is recorded as a
// version so "before my next change" is restorable from the history.
export const HUMAN_SNAPSHOT_IDLE_MS = 2500
const MAX_BURST_SUMMARIES = 4
const humanBursts = new Map<string, { timer: ReturnType<typeof setTimeout>; summaries: string[] }>()
// A flow artboard reports its height on every reflow; the persist waits for
// the content to settle.
export const FLOW_HEIGHT_PERSIST_MS = 500
const flowHeightTimers = new Map<string, ReturnType<typeof setTimeout>>()

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

export function cancelFlowHeightPersists(): void {
  for (const timer of flowHeightTimers.values()) clearTimeout(timer)
  flowHeightTimers.clear()
}

export function resetLocalState(): void {
  cancelHumanSnapshots()
  cancelFlowHeightPersists()
  history.clearAll()
  indexes.clear()
  transientBase.clear()
  for (const [id, epoch] of sendEpochs) sendEpochs.set(id, epoch + 1)
}

export function forgetArtboard(artboardId: string): void {
  const burst = humanBursts.get(artboardId)
  if (burst) clearTimeout(burst.timer)
  humanBursts.delete(artboardId)
  const flowTimer = flowHeightTimers.get(artboardId)
  if (flowTimer) clearTimeout(flowTimer)
  flowHeightTimers.delete(artboardId)
  indexes.delete(artboardId)
  history.clear(artboardId)
  transientBase.delete(artboardId)
  sendEpochs.set(artboardId, (sendEpochs.get(artboardId) ?? 0) + 1)
}

// ---- pure helpers ----

export function maybeToastRemoteUpdate(artboard: DesignArtboard, onView: () => void): void {
  const now = Date.now()
  if (now - (lastRemoteToastAt.get(artboard.id) ?? 0) < REMOTE_TOAST_THROTTLE_MS) return
  lastRemoteToastAt.set(artboard.id, now)
  showAgentToast('update', artboard.id, artboard.name, onView, now)
}

export function burstSummary(summaries: readonly string[]): string {
  const unique = [...new Set(summaries.map((s) => s.trim()).filter(Boolean))]
  if (unique.length === 0) return 'Edição manual'
  const shown = unique.slice(0, MAX_BURST_SUMMARIES).join(', ')
  return unique.length > MAX_BURST_SUMMARIES ? `${shown} …` : shown
}

function scheduleHumanSnapshot(store: DesignStore, artboardId: string, summary?: string): void {
  const burst = humanBursts.get(artboardId)
  if (burst) clearTimeout(burst.timer)
  const summaries = [...(burst?.summaries ?? []), ...(summary ? [summary] : [])]
  const timer = setTimeout(() => {
    humanBursts.delete(artboardId)
    if (!store.getState().artboards[artboardId]) return
    sendOps(store, artboardId, [], { snapshot: true, summary: burstSummary(summaries) })
  }, HUMAN_SNAPSHOT_IDLE_MS)
  humanBursts.set(artboardId, { timer, summaries })
}

export function cancelHumanSnapshots(): void {
  for (const burst of humanBursts.values()) clearTimeout(burst.timer)
  humanBursts.clear()
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
    sizing: meta.sizing,
  }
}

export function applyArtboardOps(meta: DesignArtboard, ops: readonly DesignOp[]): DesignArtboard {
  let next = meta
  for (const op of ops) if (op.type === 'setArtboard') next = { ...next, ...op.patch }
  return next
}

// `only` limits the read (and the index rebuild) to some artboards: adopting
// a new one must not reindex the ones already live in the store.
export function artboardsOf(
  doc: DesignDocument,
  only: (id: string) => boolean = () => true,
): Record<string, ArtboardState> {
  const out: Record<string, ArtboardState> = {}
  for (const page of doc.pages) {
    for (const ab of page.artboards) {
      if (!only(ab.id)) continue
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

export function upsertMeta(
  list: DesignDocumentMeta[],
  meta: DesignDocumentMeta,
): DesignDocumentMeta[] {
  return [...list.filter((m) => m.id !== meta.id), meta].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function toMeta(doc: DesignDocument): DesignDocumentMeta {
  const { id, title, status, thumbnail, createdAt, updatedAt } = doc
  return { id, title, status, thumbnail, createdAt, updatedAt }
}

// Canvas-space bounds of the selection: node rects come from the iframe,
// an artboard-only selection uses its frame. Null without a selection.
export async function selectionBounds(store: DesignStore): Promise<Rect | null> {
  const { selection, artboards } = store.getState()
  if (!selection.artboardId) return null
  const meta = artboards[selection.artboardId]?.meta
  if (!meta) return null
  const frame = { x: meta.x, y: meta.y, w: meta.width, h: meta.height }
  if (selection.nodeIds.length === 0) return frame
  const bridge = bridges.get(selection.artboardId)
  if (!bridge) return frame
  let rects: Record<string, Rect>
  try {
    rects = await bridge.getRects(selection.nodeIds)
  } catch {
    return frame
  }
  const local = unionRects(Object.values(rects))
  if (!local) return frame
  return { x: meta.x + local.x, y: meta.y + local.y, w: local.w, h: local.h }
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
    // The runtime refusing an op (not initialised yet, node missing) means its
    // DOM no longer mirrors the tree: repaint it from the store.
    void bridge.applyOps(ops).then(
      (res) => {
        if (!res.ok) bridge.reinit()
      },
      () => bridge.reinit(),
    )
  }
  return true
}

// Called after a failed send: whatever this client queued or could undo was
// computed against a tree the server never accepted.
function dropLocalPending(artboardId: string): void {
  sendEpochs.set(artboardId, (sendEpochs.get(artboardId) ?? 0) + 1)
  history.clear(artboardId)
  transientBase.delete(artboardId)
}

export function sendOps(
  store: DesignStore,
  artboardId: string,
  ops: DesignOp[],
  opts: CommitOptions,
): void {
  if (!opts.snapshot && !opts.quiet) scheduleHumanSnapshot(store, artboardId, opts.summary)
  const prev = sendChains.get(artboardId) ?? Promise.resolve()
  const epoch = sendEpochs.get(artboardId) ?? 0
  const next = prev.then(async () => {
    const ab = store.getState().artboards[artboardId]
    if (!ab || (sendEpochs.get(artboardId) ?? 0) !== epoch) return
    const nonce = newNonce()
    pendingNonces.add(nonce)
    try {
      const evt = await api.design.artboardApplyOps({
        artboardId,
        ops,
        origin: { kind: 'human', sessionId: null, nonce },
        // A quiet write (measured height) touches no node: it must not
        // conflict with an agent's tree edit racing it.
        baseVersion: opts.quiet ? undefined : ab.version,
        snapshot: opts.quiet ? false : opts.snapshot,
        summary: opts.summary,
      })
      bumpVersion(store, artboardId, evt.version)
    } catch (err) {
      pendingNonces.delete(nonce)
      // A quiet write carries a measurement, not an edit: losing it costs
      // nothing the human did, so the undo history and the tree stay put.
      if (opts.quiet) return
      dropLocalPending(artboardId)
      if (isVersionConflict(err)) {
        store.setState({ conflict: { artboardId } })
      } else {
        store.setState({
          error: err instanceof Error ? err.message : String(err),
        })
      }
      // Either way the local tree diverged from what the server holds.
      await store.getState().resync(artboardId)
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

// The iframe grows in the same frame (setLocal only: nothing reaches the
// runtime, which ignores height in flow anyway, nor the undo history); the
// server learns the height once the content stops moving.
export function reportFlowHeightAction(store: DesignStore, artboardId: string, h: number): void {
  const ab = store.getState().artboards[artboardId]
  if (!ab || ab.meta.sizing !== 'flow' || !Number.isFinite(h)) return
  const next = clampArtboardSize(Math.max(MIN_FLOW_HEIGHT_PX, Math.round(h)))
  if (Math.abs(next - ab.meta.height) < 1) return
  setLocal(store, artboardId, ab.tree, { ...ab.meta, height: next })
  const base = transientBase.get(artboardId)
  if (base) transientBase.set(artboardId, { ...base, meta: { ...base.meta, height: next } })
  const pending = flowHeightTimers.get(artboardId)
  if (pending) clearTimeout(pending)
  flowHeightTimers.set(
    artboardId,
    setTimeout(() => {
      flowHeightTimers.delete(artboardId)
      const cur = store.getState().artboards[artboardId]
      if (!cur || cur.meta.sizing !== 'flow') return
      const patch: ArtboardPatch = { height: cur.meta.height }
      sendOps(store, artboardId, [{ type: 'setArtboard', patch }], { quiet: true })
    }, FLOW_HEIGHT_PERSIST_MS),
  )
}
