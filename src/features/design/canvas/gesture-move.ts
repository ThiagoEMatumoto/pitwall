// Per-tick math for move (absolute drag, flex reorder, reparent) and resize,
// plus the final commit of a move. Pure apart from what the host provides:
// hit-tests/rects through the bridge and commits through the store.

import type { Rect } from '@shared/design/protocol'
import type { DesignOp } from '@shared/types/design'
import { rectContains } from './geometry'
import { isFlexLayout, planMove, planReparent, planResize, resizeRect } from './drag-plan'
import { planReorder } from './reorder-plan'
import { computeSnap, type SnapEdge, type SnapGuide } from './snapping'
import { dropFrameOnPath, prepareDropTarget } from './drag-prep'
import {
  gestureFeedback,
  type GestureHost,
  type MoveGesture,
  type ResizeGesture,
} from './interaction-state'

export function tickMove(host: GestureHost, g: MoveGesture): void {
  const dx = g.last.x - g.start.x
  const dy = g.last.y - g.start.y
  const { prep } = g
  const outsideFlexParent = prep.flex !== null && !rectContains(prep.flex.parentRect, g.last)
  if (g.mods.alt || outsideFlexParent) probeDrop(host, g)
  else if (g.drop) g.drop = null

  if (g.drop) {
    const flexDrop = isFlexLayout(g.drop.layout)
    const plan = flexDrop
      ? planReorder(g.drop.siblings, g.drop.layout, g.last, g.ids, g.drop.rect)
      : null
    g.dropIndex = plan ? plan.index : g.drop.siblings.length
    gestureFeedback().update({
      dropTarget: g.drop.rect,
      insertion: plan?.line ?? null,
      guides: [],
    })
  } else if (prep.flex) {
    const plan = planReorder(
      prep.flex.siblings,
      prep.flex.layout,
      g.last,
      g.ids,
      prep.flex.parentRect,
    )
    g.reorderIndex = plan.index
    gestureFeedback().update({ insertion: plan.line, dropTarget: null, guides: [] })
    return
  } else {
    gestureFeedback().update({ dropTarget: null, insertion: null })
  }

  // Absolute nodes keep following the pointer even while a drop is probed.
  const moving: Rect = {
    ...prep.primary.rect,
    x: prep.primary.rect.x + dx,
    y: prep.primary.rect.y + dy,
  }
  const snap = g.drop
    ? { dx: 0, dy: 0, guides: [] }
    : computeSnap(moving, prep.snapCandidates, host.snapThreshold())
  g.delta = { x: dx + snap.dx, y: dy + snap.dy }
  if (!g.drop) gestureFeedback().update({ guides: snap.guides })
  const ops = planMove(prep.nodes, g.delta.x, g.delta.y)
  if (ops.length === 0) return
  g.dirty = true
  host.commitTransient(ops, `move:${prep.primary.node.id}`)
}

// Hit-test under the pointer (ignoring the moving nodes) and, when the frame
// changes, fetch its layout/children once.
function probeDrop(host: GestureHost, g: MoveGesture): void {
  if (g.probing) return
  g.probing = true
  const seq = ++g.probeSeq
  const homeId = g.prep.primary.parent?.id ?? null
  void host.bridge
    .hitTest(g.last.x, g.last.y, g.ids)
    .then(async (hit) => {
      if (!host.isCurrent(g) || seq !== g.probeSeq) return
      const targetId = dropFrameOnPath(host.artboardId, hit.path, g.ids)
      if (!targetId || targetId === homeId) {
        if (g.drop) {
          g.drop = null
          host.scheduleTick()
        }
        return
      }
      if (g.drop?.id === targetId) return
      const drop = await prepareDropTarget(host.artboardId, host.bridge, targetId, g.ids)
      if (!host.isCurrent(g) || seq !== g.probeSeq) return
      g.drop = drop
      host.scheduleTick()
    })
    .catch(() => undefined)
    .finally(() => {
      g.probing = false
    })
}

export function tickResize(host: GestureHost, g: ResizeGesture): void {
  let dx = g.last.x - g.start.x
  let dy = g.last.y - g.start.y
  let guides: SnapGuide[] = []
  if (!g.mods.alt) {
    const edgeX: SnapEdge[] = g.handle.includes('e')
      ? ['end']
      : g.handle.includes('w')
        ? ['start']
        : []
    const edgeY: SnapEdge[] = g.handle.includes('s')
      ? ['end']
      : g.handle.includes('n')
        ? ['start']
        : []
    const next = resizeRect(g.node.rect, g.handle, dx, dy, g.mods)
    const snap = computeSnap(next, g.candidates, host.snapThreshold(), {
      edgesX: edgeX,
      edgesY: edgeY,
    })
    dx += snap.dx
    dy += snap.dy
    guides = snap.guides
  }
  g.delta = { x: dx, y: dy }
  gestureFeedback().update({ guides })
  g.dirty = true
  host.commitTransient(planResize(g.node, g.handle, dx, dy, g.mods), `resize:${g.node.node.id}`)
}

export function finishMove(host: GestureHost, g: MoveGesture): void {
  const { prep } = g
  if (g.drop) {
    const target = {
      id: g.drop.id,
      rect: g.drop.rect,
      layout: g.drop.layout,
      index: g.dropIndex,
    }
    host.commit(planReparent(prep.nodes, target, g.delta.x, g.delta.y), 'Move into frame', true)
    return
  }
  if (prep.flex) {
    if (g.reorderIndex === null || g.reorderIndex === currentReorderIndex(g)) return
    const op: DesignOp = {
      type: 'move',
      ids: g.ids,
      parentId: prep.flex.parentId,
      index: g.reorderIndex,
    }
    host.commit([op], 'Reorder', true)
    return
  }
  host.commit(planMove(prep.nodes, g.delta.x, g.delta.y), 'Move', g.dirty)
}

// Index the primary already has among its non-moving siblings.
function currentReorderIndex(g: MoveGesture): number {
  const siblings = g.prep.flex!.siblings
  const at = siblings.findIndex((s) => s.id === g.prep.primary.node.id)
  return siblings.slice(0, at).filter((s) => !g.ids.includes(s.id)).length
}
