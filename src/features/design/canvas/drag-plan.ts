// Pure planners for canvas gestures: they turn a start snapshot (node, its
// rect, its parent) plus a pointer delta into DesignOps. Nothing here touches
// the store or the bridge, so InteractionLayer and the keyboard shortcuts
// (nudge/align/distribute) share the same math. All rects are artboard-local.

import type { Rect } from '@shared/design/protocol'
import type { DesignNode, DesignOp } from '@shared/types/design'
import type { Point } from './geometry'

export interface ParentLayout {
  display: string
  flexDirection: string
  flexWrap: string
}

export interface DragNode {
  node: DesignNode
  // Rect at gesture start.
  rect: Rect
  parent: DesignNode | null
  parentRect: Rect | null
  parentLayout: ParentLayout | null
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se'

// Same order as the overlay draws them.
export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']

export const HANDLE_CURSOR: Record<ResizeHandle, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
}

export type AlignKind = 'left' | 'right' | 'top' | 'bottom' | 'centerH' | 'centerV'

export const MIN_SIZE_PX = 1

const DEFAULT_LAYOUT: ParentLayout = {
  display: 'block',
  flexDirection: 'row',
  flexWrap: 'nowrap',
}

export function parsePx(value: string | undefined): number | null {
  if (!value) return null
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim())
  return m ? Number(m[1]) : null
}

export function layoutFromStyle(style: Record<string, string>): ParentLayout {
  return {
    display: style.display || DEFAULT_LAYOUT.display,
    flexDirection: style.flexDirection || style['flex-direction'] || DEFAULT_LAYOUT.flexDirection,
    flexWrap: style.flexWrap || style['flex-wrap'] || DEFAULT_LAYOUT.flexWrap,
  }
}

export function isFlexLayout(layout: ParentLayout | null): boolean {
  return layout?.display === 'flex' || layout?.display === 'inline-flex'
}

export function isAbsolute(node: DesignNode): boolean {
  return node.style.position === 'absolute' || node.style.position === 'fixed'
}

export function isFlexChild(d: DragNode): boolean {
  return isFlexLayout(d.parentLayout) && !isAbsolute(d.node)
}

function movable(d: DragNode): boolean {
  return d.parent !== null && !d.node.locked
}

// Center of the 8 handles of `rect`, in the RESIZE_HANDLES order.
export function handleCenters(rect: Rect): Array<[ResizeHandle, number, number]> {
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  const r = rect.x + rect.w
  const b = rect.y + rect.h
  return [
    ['nw', rect.x, rect.y],
    ['n', cx, rect.y],
    ['ne', r, rect.y],
    ['w', rect.x, cy],
    ['e', r, cy],
    ['sw', rect.x, b],
    ['s', cx, b],
    ['se', r, b],
  ]
}

export function handleAt(point: Point, rect: Rect, radius: number): ResizeHandle | null {
  let best: { handle: ResizeHandle; dist: number } | null = null
  for (const [handle, hx, hy] of handleCenters(rect)) {
    const dist = Math.hypot(point.x - hx, point.y - hy)
    if (dist <= radius && (!best || dist < best.dist)) best = { handle, dist }
  }
  return best?.handle ?? null
}

// ---- position ----

// left/top the node needs so its rect lands at (x, y). Nodes already
// positioned in px keep their own offsets (safe against parent borders);
// others derive the offset from the start rect relative to the parent.
function positionPatch(d: DragNode, x?: number, y?: number): Record<string, string | null> {
  const patch: Record<string, string | null> = {}
  const absolute = isAbsolute(d.node)
  const origin = d.parentRect ?? { x: 0, y: 0 }
  if (x !== undefined) {
    const left = absolute ? parsePx(d.node.style.left) : null
    const base = left ?? d.rect.x - origin.x
    patch.left = `${Math.round(base + (x - d.rect.x))}px`
    if (d.node.style.right && left === null) patch.right = null
  }
  if (y !== undefined) {
    const top = absolute ? parsePx(d.node.style.top) : null
    const base = top ?? d.rect.y - origin.y
    patch.top = `${Math.round(base + (y - d.rect.y))}px`
    if (d.node.style.bottom && top === null) patch.bottom = null
  }
  if (!absolute) {
    patch.position = 'absolute'
    if (x === undefined) patch.left = `${Math.round(d.rect.x - origin.x)}px`
    if (y === undefined) patch.top = `${Math.round(d.rect.y - origin.y)}px`
  }
  return patch
}

// A static child becoming absolute needs a positioned ancestor: frames get
// position:relative once (they never had a position of their own).
function containerOps(nodes: readonly DragNode[]): DesignOp[] {
  const ops: DesignOp[] = []
  const seen = new Set<string>()
  for (const d of nodes) {
    const parent = d.parent
    if (!parent || isAbsolute(d.node) || seen.has(parent.id)) continue
    if (parent.kind !== 'frame' || parent.style.position) continue
    seen.add(parent.id)
    ops.push({
      type: 'setStyle',
      id: parent.id,
      patch: { position: 'relative' },
    })
  }
  return ops
}

function placeOps(
  nodes: readonly DragNode[],
  target: (d: DragNode) => { x?: number; y?: number },
): DesignOp[] {
  const placed = nodes.filter((d) => movable(d) && !isFlexChild(d))
  const ops = containerOps(placed)
  for (const d of placed) {
    const { x, y } = target(d)
    if (x === undefined && y === undefined) continue
    ops.push({
      type: 'setStyle',
      id: d.node.id,
      patch: positionPatch(d, x, y),
    })
  }
  return ops
}

// ---- move / nudge ----

export function planMove(nodes: readonly DragNode[], dx: number, dy: number): DesignOp[] {
  return placeOps(nodes, (d) => ({ x: d.rect.x + dx, y: d.rect.y + dy }))
}

export function planNudge(nodes: readonly DragNode[], dx: number, dy: number): DesignOp[] {
  return planMove(nodes, dx, dy)
}

// ---- resize ----

export interface ResizeMods {
  shift?: boolean
  alt?: boolean
}

export function resizeRect(
  start: Rect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  mods: ResizeMods = {},
): Rect {
  const hasN = handle.includes('n')
  const hasS = handle.includes('s')
  const hasE = handle.includes('e')
  const hasW = handle.includes('w')
  let dw = hasE ? dx : hasW ? -dx : 0
  let dh = hasS ? dy : hasN ? -dy : 0
  if (mods.alt) {
    dw *= 2
    dh *= 2
  }
  if (mods.shift && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h
    const horizontalOnly = (hasE || hasW) && !(hasN || hasS)
    const verticalOnly = (hasN || hasS) && !(hasE || hasW)
    if (horizontalOnly || (!verticalOnly && Math.abs(dw) / start.w >= Math.abs(dh) / start.h)) {
      dh = dw / ratio
    } else {
      dw = dh * ratio
    }
  }
  const w = Math.max(MIN_SIZE_PX, start.w + dw)
  const h = Math.max(MIN_SIZE_PX, start.h + dh)
  if (mods.alt) {
    return {
      x: start.x - (w - start.w) / 2,
      y: start.y - (h - start.h) / 2,
      w,
      h,
    }
  }
  return {
    x: hasW ? start.x + start.w - w : start.x,
    y: hasN ? start.y + start.h - h : start.y,
    w,
    h,
  }
}

function fillPatch(d: DragNode): Record<string, string | null> {
  if (!isFlexChild(d)) return {}
  const { flex, flexGrow } = d.node.style
  const fills =
    (flex && flex !== 'none' && !/^0(\s|$)/.test(flex)) || (flexGrow && flexGrow !== '0')
  if (!fills) return {}
  return { flex: 'none', flexGrow: null, flexShrink: null, flexBasis: null }
}

export function planResize(
  d: DragNode,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  mods: ResizeMods = {},
): DesignOp[] {
  if (d.node.locked) return []
  const next = resizeRect(d.rect, handle, dx, dy, mods)
  const patch: Record<string, string | null> = {
    width: `${Math.round(next.w)}px`,
    height: `${Math.round(next.h)}px`,
    ...fillPatch(d),
  }
  if (isAbsolute(d.node)) {
    const x = next.x !== d.rect.x ? next.x : undefined
    const y = next.y !== d.rect.y ? next.y : undefined
    if (x !== undefined || y !== undefined) Object.assign(patch, positionPatch(d, x, y))
  }
  return [{ type: 'setStyle', id: d.node.id, patch }]
}

// ---- reparent ----

export function planReparent(
  nodes: readonly DragNode[],
  target: { id: string; rect: Rect; layout: ParentLayout; index: number },
  dx: number,
  dy: number,
): DesignOp[] {
  const moving = nodes.filter(movable)
  if (moving.length === 0) return []
  const ids = moving.map((d) => d.node.id)
  const ops: DesignOp[] = [{ type: 'move', ids, parentId: target.id, index: target.index }]
  if (isFlexLayout(target.layout)) return ops
  for (const d of moving) {
    const rebased: DragNode = {
      ...d,
      parentRect: target.rect,
      parentLayout: target.layout,
    }
    // Offsets from the old parent are meaningless in the new one: rebuild
    // from the rect, as if the node were static.
    const node = {
      ...d.node,
      style: {
        ...d.node.style,
        position: 'static',
        left: '',
        top: '',
        right: '',
        bottom: '',
      },
    }
    const patch = positionPatch({ ...rebased, node }, d.rect.x + dx, d.rect.y + dy)
    if (d.node.style.right) patch.right = null
    if (d.node.style.bottom) patch.bottom = null
    ops.push({ type: 'setStyle', id: d.node.id, patch })
  }
  return ops
}

// ---- align / distribute (keyboard) ----

export function unionOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const r = Math.max(...rects.map((r) => r.x + r.w))
  const b = Math.max(...rects.map((r) => r.y + r.h))
  return { x, y, w: r - x, h: b - y }
}

// One node aligns to its parent; several align to their common bounds.
export function planAlign(nodes: readonly DragNode[], kind: AlignKind, target?: Rect): DesignOp[] {
  const bounds =
    target ?? (nodes.length === 1 ? nodes[0].parentRect : unionOf(nodes.map((d) => d.rect)))
  if (!bounds) return []
  return placeOps(nodes, (d) => {
    switch (kind) {
      case 'left':
        return { x: bounds.x }
      case 'right':
        return { x: bounds.x + bounds.w - d.rect.w }
      case 'centerH':
        return { x: bounds.x + (bounds.w - d.rect.w) / 2 }
      case 'top':
        return { y: bounds.y }
      case 'bottom':
        return { y: bounds.y + bounds.h - d.rect.h }
      case 'centerV':
        return { y: bounds.y + (bounds.h - d.rect.h) / 2 }
    }
  })
}

// Even gaps between the outermost nodes, which stay where they are.
export function planDistribute(nodes: readonly DragNode[], axis: 'x' | 'y'): DesignOp[] {
  if (nodes.length < 3) return []
  const size = (d: DragNode): number => (axis === 'x' ? d.rect.w : d.rect.h)
  const start = (d: DragNode): number => (axis === 'x' ? d.rect.x : d.rect.y)
  const sorted = [...nodes].sort((a, b) => start(a) - start(b))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const span = start(last) + size(last) - start(first)
  const gap = (span - sorted.reduce((n, d) => n + size(d), 0)) / (sorted.length - 1)
  const targets = new Map<string, number>()
  let cursor = start(first)
  for (const d of sorted) {
    targets.set(d.node.id, cursor)
    cursor += size(d) + gap
  }
  return placeOps(sorted.slice(1, -1), (d) => {
    const at = targets.get(d.node.id)!
    return axis === 'x' ? { x: at } : { y: at }
  })
}
