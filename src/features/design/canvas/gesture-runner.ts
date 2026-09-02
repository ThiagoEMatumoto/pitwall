// Gesture state machine for one artboard, driven by InteractionLayer's
// pointer events. A press resolves (via hitTest) into move / reorder /
// reparent / resize / marquee / draw once the pointer travels past the click
// threshold. Ticks are rAF-throttled and commit transient ops; pointerup
// commits the single final op.

import { getNodeIndex, useDesignStore, type DesignTool } from '@/store/designStore'
import type { HitMessage, Rect } from '@shared/design/protocol'
import type { DesignOp } from '@shared/types/design'
import type { ArtboardBridge } from './runtime-bridge'
import { rectFromPoints, rectsIntersect, type Point } from './geometry'
import { planResize } from './drag-plan'
import {
  dropFrameOnPath,
  prepareDropTarget,
  prepareMove,
  prepareResize,
  scopeChildrenRects,
  type DropTarget,
} from './drag-prep'
import { planInsertForTool } from './draw-tools'
import { SNAP_THRESHOLD_PX } from './snapping'
import { finishMove, tickMove, tickResize } from './gesture-move'
import {
  CLICK_THRESHOLD_PX,
  DEFAULT_DRAW_SIZE,
  gestureFeedback,
  resolveClickTarget,
  type Gesture,
  type GestureHost,
  type MarqueeGesture,
  type Mods,
  type PressGesture,
} from './interaction-state'

export class GestureRunner implements GestureHost {
  private gesture: Gesture | null = null
  private frame: number | null = null

  constructor(
    readonly artboardId: string,
    public bridge: ArtboardBridge,
  ) {}

  active(pointerId: number): boolean {
    return this.gesture !== null && this.gesture.pointerId === pointerId
  }

  isCurrent(g: Gesture): boolean {
    return this.gesture === g
  }

  dispose(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    if (this.gesture) gestureFeedback().clear()
    this.gesture = null
    // Unmounted mid-drag: the transient ops never reached the server.
    useDesignStore.getState().releaseTransient(this.artboardId)
  }

  press(g: PressGesture): void {
    this.gesture = g
    if (g.handle) return
    void this.bridge
      .hitTest(g.start.x, g.start.y)
      .then((hit) => {
        if (this.gesture !== g) return
        g.hit = hit
        if (g.moved) void this.begin(g)
      })
      .catch(() => undefined)
  }

  move(p: Point, mods: Mods): void {
    const g = this.gesture
    if (!g) return
    g.last = p
    if (g.kind === 'press') {
      if (!g.moved) {
        const zoom = useDesignStore.getState().viewport.zoom
        if (Math.hypot(p.x - g.start.x, p.y - g.start.y) * zoom <= CLICK_THRESHOLD_PX) return
        g.moved = true
      }
      if (!g.preparing && (g.handle || g.hit)) void this.begin(g)
      return
    }
    if (g.kind === 'move' || g.kind === 'resize') g.mods = mods
    this.scheduleTick()
  }

  up(p: Point, mods: Mods): void {
    const g = this.gesture
    if (!g) return
    g.last = p
    this.gesture = null
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    gestureFeedback().clear()
    this.finish(g, mods)
    // A gesture that ended without a final commit (nothing changed, cancel)
    // still applied transient ops; the store must not keep their base.
    useDesignStore.getState().releaseTransient(this.artboardId)
  }

  private finish(g: Gesture, mods: Mods): void {
    switch (g.kind) {
      case 'press':
        if (!g.moved) void this.click(g)
        return
      case 'move':
        g.mods = mods
        finishMove(this, g)
        return
      case 'resize':
        this.commit(planResize(g.node, g.handle, g.delta.x, g.delta.y, mods), 'Resize', g.dirty)
        return
      case 'marquee':
        void this.finishMarquee(g)
        return
      case 'draw':
        this.insertForTool(g.tool, rectFromPoints(g.start, g.last), g.target)
        return
    }
  }

  // ---- press → gesture ----

  private async begin(g: PressGesture): Promise<void> {
    g.preparing = true
    const next = await this.gestureFor(g).catch(() => null)
    if (this.gesture !== g) return
    this.gesture = next
    if (next) {
      gestureFeedback().update({ artboardId: this.artboardId, active: true })
      useDesignStore.getState().setHover(null)
      this.scheduleTick()
    }
  }

  private async gestureFor(g: PressGesture): Promise<Gesture | null> {
    const base = { pointerId: g.pointerId, start: g.start, last: g.last }
    if (g.tool !== 'move') {
      const target = await this.drawTarget(g.hit)
      return target ? { kind: 'draw', ...base, tool: g.tool, target } : null
    }
    if (g.handle) {
      const prep = await prepareResize(this.artboardId, this.bridge, g.handle.nodeId)
      if (!prep) return null
      return {
        kind: 'resize',
        ...base,
        mods: { shift: g.shift, alt: g.alt },
        node: prep.node,
        handle: g.handle.handle,
        candidates: prep.snapCandidates,
        delta: { x: 0, y: 0 },
        dirty: false,
      }
    }
    const { scopeId, selection, select } = useDesignStore.getState()
    const target = resolveClickTarget(g.hit?.path ?? [], scopeId, g.deep)
    if (!target) return { kind: 'marquee', ...base, additive: g.shift }
    const selected = selection.artboardId === this.artboardId ? selection.nodeIds : []
    const ids = selected.includes(target) ? selected : g.shift ? [...selected, target] : [target]
    if (ids !== selected) select(this.artboardId, ids)
    const prep = await prepareMove(this.artboardId, this.bridge, ids, target)
    if (!prep) return null
    return {
      kind: 'move',
      ...base,
      mods: { shift: g.shift, alt: g.alt },
      prep,
      ids: prep.nodes.map((d) => d.node.id),
      delta: { x: 0, y: 0 },
      dirty: false,
      reorderIndex: null,
      drop: null,
      dropIndex: 0,
      probeSeq: 0,
      probing: false,
    }
  }

  private async drawTarget(hit: HitMessage | null): Promise<DropTarget | null> {
    const root = useDesignStore.getState().artboards[this.artboardId]?.tree.id
    const frameId = dropFrameOnPath(this.artboardId, hit?.path ?? []) ?? root
    if (!frameId) return null
    return prepareDropTarget(this.artboardId, this.bridge, frameId, [])
  }

  // ---- ticks ----

  scheduleTick(): void {
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.tick()
    })
  }

  private tick(): void {
    const g = this.gesture
    if (!g) return
    switch (g.kind) {
      case 'move':
        tickMove(this, g)
        return
      case 'resize':
        tickResize(this, g)
        return
      case 'marquee':
        gestureFeedback().update({ marquee: rectFromPoints(g.start, g.last) })
        return
      case 'draw':
        gestureFeedback().update({
          drawing: rectFromPoints(g.start, g.last),
          dropTarget: g.target.rect,
        })
        return
      default:
        return
    }
  }

  snapThreshold(): number {
    return SNAP_THRESHOLD_PX / useDesignStore.getState().viewport.zoom
  }

  // ---- pointerup ----

  private async finishMarquee(g: MarqueeGesture): Promise<void> {
    const rect = rectFromPoints(g.start, g.last)
    const children = await scopeChildrenRects(this.artboardId, this.bridge).catch(() => [])
    const hits = children.filter((c) => rectsIntersect(rect, c.rect)).map((c) => c.id)
    const { selection, select } = useDesignStore.getState()
    const previous = g.additive && selection.artboardId === this.artboardId ? selection.nodeIds : []
    select(this.artboardId, Array.from(new Set([...previous, ...hits])))
  }

  private async click(g: PressGesture): Promise<void> {
    if (g.handle) return
    const hit = g.hit ?? (await this.bridge.hitTest(g.start.x, g.start.y).catch(() => null))
    if (g.tool !== 'move') {
      const target = await this.drawTarget(hit)
      if (!target) return
      const rect = {
        x: g.start.x,
        y: g.start.y,
        w: DEFAULT_DRAW_SIZE,
        h: DEFAULT_DRAW_SIZE,
      }
      this.insertForTool(g.tool, rect, target)
      return
    }
    const { scopeId, selection, select } = useDesignStore.getState()
    const target = resolveClickTarget(hit?.path ?? [], scopeId, g.deep)
    if (!target) {
      if (!g.shift) select(this.artboardId, [])
      return
    }
    if (g.shift && selection.artboardId === this.artboardId) {
      const ids = selection.nodeIds.includes(target)
        ? selection.nodeIds.filter((id) => id !== target)
        : [...selection.nodeIds, target]
      select(this.artboardId, ids)
      return
    }
    select(this.artboardId, [target])
  }

  // ---- commits ----

  private insertForTool(tool: DesignTool, rect: Rect, target: DropTarget): void {
    if (tool === 'move' || tool === 'hand') return
    const round = (n: number): number => Math.round(n)
    // draw-tools works in parent-local space; a click is a zero rect there.
    const isClick = rect.w < 2 && rect.h < 2
    const local = {
      x: round(rect.x - target.rect.x),
      y: round(rect.y - target.rect.y),
      w: isClick ? 0 : round(rect.w),
      h: isClick ? 0 : round(rect.h),
    }
    const plan = planInsertForTool(tool, local, target.id, target.childCount)
    const ops: DesignOp[] = []
    const parent = getNodeIndex(this.artboardId)?.get(target.id)
    if (
      parent &&
      parent.parentId !== null &&
      parent.node.kind === 'frame' &&
      !parent.node.style.position
    ) {
      ops.push({ type: 'setStyle', id: target.id, patch: { position: 'relative' } })
    }
    ops.push(...plan.ops)
    const state = useDesignStore.getState()
    state.commit(this.artboardId, ops, { summary: `Insert ${tool}` })
    state.select(this.artboardId, [plan.newId])
    state.setTool('move')
  }

  commitTransient(ops: DesignOp[], coalesceKey: string): void {
    useDesignStore.getState().commit(this.artboardId, ops, { transient: true, coalesceKey })
  }

  // The final op of a drag. When nothing changed, up() releases the store's
  // transient base instead.
  commit(ops: DesignOp[], summary: string, dirty: boolean): void {
    if (!dirty || ops.length === 0) return
    useDesignStore.getState().commit(this.artboardId, ops, { summary })
  }
}
