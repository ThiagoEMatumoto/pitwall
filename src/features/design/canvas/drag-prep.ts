// Async "snapshot" builders a gesture needs before it can plan ops: node
// rects, parent rects and parent layouts, fetched from the runtime once at
// pointerdown so every tick (drag-plan.ts) is pure math.

import { getNodeIndex, useDesignStore } from '@/store/designStore'
import type { IndexEntry } from '@shared/design/ops'
import type { Rect } from '@shared/design/protocol'
import type { DesignNode } from '@shared/types/design'
import type { ArtboardBridge } from './runtime-bridge'
import { layoutFromStyle, type DragNode, type ParentLayout } from './drag-plan'

export interface SiblingRect {
  id: string
  rect: Rect
}

export interface FlexContext {
  parentId: string
  parentRect: Rect
  layout: ParentLayout
  siblings: SiblingRect[]
}

export interface MovePrep {
  nodes: DragNode[]
  primary: DragNode
  // Set when the primary is a flex child: move becomes reorder.
  flex: FlexContext | null
  snapCandidates: Rect[]
}

export interface DropTarget {
  id: string
  rect: Rect
  layout: ParentLayout
  // Visible children not being moved (for reorder math).
  siblings: SiblingRect[]
  // All children, hidden included: the index an append uses.
  childCount: number
}

function artboardRect(artboardId: string): Rect {
  const meta = useDesignStore.getState().artboards[artboardId]?.meta
  return { x: 0, y: 0, w: meta?.width ?? 0, h: meta?.height ?? 0 }
}

// Computed beats inline style: a class/global CSS may make the parent flex.
async function layoutOf(bridge: ArtboardBridge, node: DesignNode): Promise<ParentLayout> {
  try {
    const c = await bridge.getComputed(node.id, ['display', 'flex-direction', 'flex-wrap'])
    if (c.display) {
      return {
        display: c.display,
        flexDirection: c['flex-direction'] || 'row',
        flexWrap: c['flex-wrap'] || 'nowrap',
      }
    }
  } catch {
    // Runtime busy or gone: fall back to the inline style.
  }
  return layoutFromStyle(node.style)
}

function isLocked(entry: IndexEntry): boolean {
  return Boolean(entry.node.locked) || Boolean(useDesignStore.getState().lockedIds[entry.node.id])
}

async function rectsFor(bridge: ArtboardBridge, ids: string[]): Promise<Record<string, Rect>> {
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return {}
  return bridge.getRects(unique)
}

// Snapshot of the nodes about to move. Root and locked nodes are dropped;
// null when nothing is movable.
export async function prepareMove(
  artboardId: string,
  bridge: ArtboardBridge,
  ids: readonly string[],
  primaryId: string,
): Promise<MovePrep | null> {
  const index = getNodeIndex(artboardId)
  if (!index) return null
  const entries = ids
    .map((id) => index.get(id))
    .filter((e): e is IndexEntry => e !== undefined && e.parentId !== null && !isLocked(e))
  if (entries.length === 0) return null
  const primaryEntry = entries.find((e) => e.node.id === primaryId) ?? entries[0]
  const parentIds = Array.from(new Set(entries.map((e) => e.parentId!)))
  const primaryParent = index.get(primaryEntry.parentId!)!.node
  const siblingIds = primaryParent.children.filter((c) => !c.hidden).map((c) => c.id)

  const [rects, layouts] = await Promise.all([
    rectsFor(bridge, [...entries.map((e) => e.node.id), ...parentIds, ...siblingIds]),
    Promise.all(parentIds.map((pid) => layoutOf(bridge, index.get(pid)!.node))),
  ])
  const layoutByParent = new Map(parentIds.map((pid, i) => [pid, layouts[i]]))

  const toDrag = (e: IndexEntry): DragNode | null => {
    const rect = rects[e.node.id]
    if (!rect) return null
    const parent = index.get(e.parentId!)!.node
    return {
      node: e.node,
      rect,
      parent,
      parentRect: rects[parent.id] ?? artboardRect(artboardId),
      parentLayout: layoutByParent.get(parent.id) ?? null,
    }
  }
  const nodes = entries.map(toDrag).filter((d): d is DragNode => d !== null)
  const primary = nodes.find((d) => d.node.id === primaryEntry.node.id)
  if (!primary) return null

  const siblings = siblingIds.filter((id) => rects[id]).map((id) => ({ id, rect: rects[id] }))
  const movingIds = new Set(nodes.map((d) => d.node.id))
  const snapCandidates = [
    ...siblings.filter((s) => !movingIds.has(s.id)).map((s) => s.rect),
    primary.parentRect!,
  ]
  const flexLayout = primary.parentLayout
  const flex =
    flexLayout &&
    (flexLayout.display === 'flex' || flexLayout.display === 'inline-flex') &&
    primary.node.style.position !== 'absolute' &&
    primary.node.style.position !== 'fixed'
      ? {
          parentId: primary.parent!.id,
          parentRect: primary.parentRect!,
          layout: flexLayout,
          siblings,
        }
      : null
  return { nodes, primary, flex, snapCandidates }
}

// Snapshot of a single selected node for resize.
export async function prepareResize(
  artboardId: string,
  bridge: ArtboardBridge,
  id: string,
): Promise<{ node: DragNode; snapCandidates: Rect[] } | null> {
  const prep = await prepareMove(artboardId, bridge, [id], id)
  if (!prep) return null
  return { node: prep.primary, snapCandidates: prep.snapCandidates }
}

// Everything needed to drop `movingIds` into frame `targetId`.
export async function prepareDropTarget(
  artboardId: string,
  bridge: ArtboardBridge,
  targetId: string,
  movingIds: readonly string[],
): Promise<DropTarget | null> {
  const index = getNodeIndex(artboardId)
  const entry = index?.get(targetId)
  if (!index || !entry) return null
  const childIds = entry.node.children
    .filter((c) => !c.hidden && !movingIds.includes(c.id))
    .map((c) => c.id)
  const [rects, layout] = await Promise.all([
    rectsFor(bridge, [targetId, ...childIds]),
    layoutOf(bridge, entry.node),
  ])
  const rect = rects[targetId] ?? (entry.parentId === null ? artboardRect(artboardId) : null)
  if (!rect) return null
  return {
    id: targetId,
    rect,
    layout,
    childCount: entry.node.children.length,
    siblings: childIds.filter((id) => rects[id]).map((id) => ({ id, rect: rects[id] })),
  }
}

// Deepest frame on a hit path that can receive children (not one of the
// moving nodes; the runtime already skips their descendants).
export function dropFrameOnPath(
  artboardId: string,
  path: readonly string[],
  excludeIds: readonly string[] = [],
): string | null {
  const index = getNodeIndex(artboardId)
  if (!index) return null
  for (let i = path.length - 1; i >= 0; i--) {
    const entry = index.get(path[i])
    if (!entry || excludeIds.includes(path[i])) continue
    if (entry.node.kind === 'frame' && !isLocked(entry)) return path[i]
  }
  return null
}

// Children of the current scope (or of the root) with their rects, for marquee.
export async function scopeChildrenRects(
  artboardId: string,
  bridge: ArtboardBridge,
): Promise<SiblingRect[]> {
  const index = getNodeIndex(artboardId)
  const state = useDesignStore.getState()
  const tree = state.artboards[artboardId]?.tree
  if (!index || !tree) return []
  const scope = (state.scopeId && index.get(state.scopeId)?.node) || tree
  const ids = scope.children.filter((c) => !c.hidden).map((c) => c.id)
  const rects = await rectsFor(bridge, ids)
  return ids.filter((id) => rects[id]).map((id) => ({ id, rect: rects[id] }))
}
