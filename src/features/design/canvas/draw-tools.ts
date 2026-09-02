// Pure planners for the drawing tools and the structural shortcuts
// (group/ungroup, auto-layout, z-order, align, nudge). They only build ops;
// the caller commits them. Rects are parent-local px unless stated.

import { newNodeId } from '@shared/design/ids'
import type { Rect } from '@shared/design/protocol'
import type { DesignNode, DesignOp } from '@shared/types/design'
import type { DesignTool } from '@/store/designStore'

export type DrawTool = 'frame' | 'rect' | 'ellipse' | 'text' | 'image'
export type ZOrderDirection = 'up' | 'down' | 'top' | 'bottom'
export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'centerH' | 'centerV'

export interface DrawInsertOptions {
  assetUrl?: string
  text?: string
}

export function isDrawTool(tool: DesignTool): tool is DrawTool {
  return tool !== 'move' && tool !== 'hand'
}

// Node + where it sits in the parent-local coordinate space.
export interface PlacedNode {
  node: DesignNode
  rect: Rect
}

export const DEFAULT_DRAW_SIZE = 100
export const DUPLICATE_OFFSET = 10

// User content, not app chrome: literal colours are intentional here.
const FRAME_FILL = '#f3f4f6'
const SHAPE_FILL = '#e5e7eb'

const px = (n: number): string => `${Math.round(n)}px`

export function parsePx(value: string | undefined): number | null {
  if (value === undefined) return null
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim())
  return match ? Number(match[1]) : null
}

// A click (zero-size drag) becomes the default square anchored at the click.
export function normalizeDrawRect(rect: Rect): Rect {
  if (rect.w > 0 && rect.h > 0) return rect
  return { x: rect.x, y: rect.y, w: DEFAULT_DRAW_SIZE, h: DEFAULT_DRAW_SIZE }
}

function placement(rect: Rect): Record<string, string> {
  return {
    position: 'absolute',
    left: px(rect.x),
    top: px(rect.y),
    width: px(rect.w),
    height: px(rect.h),
  }
}

export function buildDrawNode(
  tool: DrawTool,
  rect: Rect,
  opts: DrawInsertOptions = {},
): DesignNode {
  const id = newNodeId()
  const base = { id, attrs: {}, children: [] as DesignNode[] }
  switch (tool) {
    case 'frame':
      return {
        ...base,
        tag: 'div',
        kind: 'frame',
        name: 'Frame',
        style: {
          ...placement(rect),
          background: FRAME_FILL,
          'border-radius': '8px',
        },
      }
    case 'rect':
      return {
        ...base,
        tag: 'div',
        kind: 'element',
        name: 'Rectangle',
        style: { ...placement(rect), background: SHAPE_FILL },
      }
    case 'ellipse':
      return {
        ...base,
        tag: 'div',
        kind: 'element',
        name: 'Ellipse',
        style: {
          ...placement(rect),
          background: SHAPE_FILL,
          'border-radius': '50%',
        },
      }
    case 'text': {
      // Text hugs its content vertically; only a dragged width is kept.
      const style: Record<string, string> = {
        position: 'absolute',
        left: px(rect.x),
        top: px(rect.y),
        'font-size': '16px',
        margin: '0',
      }
      if (rect.w > 0) style.width = px(rect.w)
      return {
        ...base,
        tag: 'p',
        kind: 'text',
        text: opts.text ?? 'Text',
        style,
      }
    }
    case 'image':
      return {
        ...base,
        tag: 'img',
        kind: 'image',
        name: 'Image',
        attrs: { src: opts.assetUrl ?? '', alt: '' },
        style: { ...placement(rect), 'object-fit': 'cover' },
      }
  }
}

export function planInsertForTool(
  tool: DrawTool,
  rect: Rect,
  parentId: string,
  index: number,
  opts: DrawInsertOptions = {},
): { ops: DesignOp[]; newId: string } {
  const node = buildDrawNode(tool, tool === 'text' ? rect : normalizeDrawRect(rect), opts)
  return { ops: [{ type: 'insert', parentId, index, node }], newId: node.id }
}

// ---- group / ungroup ----

function unionOf(rects: readonly Rect[]): Rect {
  const minX = Math.min(...rects.map((r) => r.x))
  const minY = Math.min(...rects.map((r) => r.y))
  const maxX = Math.max(...rects.map((r) => r.x + r.w))
  const maxY = Math.max(...rects.map((r) => r.y + r.h))
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

// Cmd+G: a new frame at `index` of `parentId` wrapping `items` (all direct
// children of that parent). Children become absolute inside the frame.
export function planWrapInFrame(
  parentId: string,
  items: readonly PlacedNode[],
  index: number,
): { ops: DesignOp[]; newId: string } {
  const bounds = unionOf(items.map((i) => i.rect))
  const frame = buildDrawNode('frame', bounds)
  const ops: DesignOp[] = [
    {
      type: 'insert',
      parentId,
      index,
      node: { ...frame, name: 'Group', style: { ...placement(bounds) } },
    },
    {
      type: 'move',
      ids: items.map((i) => i.node.id),
      parentId: frame.id,
      index: 0,
    },
    ...items.map((i): DesignOp => ({
      type: 'setStyle',
      id: i.node.id,
      patch: placement({
        x: i.rect.x - bounds.x,
        y: i.rect.y - bounds.y,
        w: i.rect.w,
        h: i.rect.h,
      }),
    })),
  ]
  return { ops, newId: frame.id }
}

// Shift+Cmd+G: children of `frame` go back to its parent at the frame's
// index, keeping their visual position; then the frame is removed.
export function planUnwrap(frame: DesignNode, parentId: string, index: number): DesignOp[] {
  if (frame.children.length === 0) return [{ type: 'remove', ids: [frame.id] }]
  const dx = parsePx(frame.style.left) ?? 0
  const dy = parsePx(frame.style.top) ?? 0
  const ops: DesignOp[] = [{ type: 'move', ids: frame.children.map((c) => c.id), parentId, index }]
  for (const child of frame.children) {
    const left = parsePx(child.style.left)
    const top = parsePx(child.style.top)
    if (child.style.position !== 'absolute' || left === null || top === null) continue
    ops.push({
      type: 'setStyle',
      id: child.id,
      patch: { left: px(left + dx), top: px(top + dy) },
    })
  }
  ops.push({ type: 'remove', ids: [frame.id] })
  return ops
}

// ---- auto-layout ----

export function planToggleAutoLayout(node: DesignNode): DesignOp {
  const on = node.style.display === 'flex'
  return {
    type: 'setStyle',
    id: node.id,
    patch: on
      ? { display: null, gap: null, 'flex-direction': null }
      : { display: 'flex', gap: '8px', 'flex-direction': 'column' },
  }
}

// ---- z-order ----

// Later in the sibling list paints on top. `index` is the node's current
// position; the move index counts siblings after the node is detached.
export function planZOrder(
  target: { id: string; parentId: string; index: number },
  dir: ZOrderDirection,
  siblingsCount: number,
): DesignOp | null {
  const last = siblingsCount - 1
  const next =
    dir === 'up' ? target.index + 1 : dir === 'down' ? target.index - 1 : dir === 'top' ? last : 0
  if (next === target.index || next < 0 || next > last) return null
  return {
    type: 'move',
    ids: [target.id],
    parentId: target.parentId,
    index: next,
  }
}

// ---- align / nudge ----

// Moves a node so its rect lands at (x, y) in parent-local space. Nodes that
// already have px offsets are shifted by the delta (margins/transforms stay
// intact); anything else becomes absolute at the target with its current size.
function planPlaceAt(item: PlacedNode, x: number, y: number): DesignOp | null {
  const dx = x - item.rect.x
  const dy = y - item.rect.y
  if (dx === 0 && dy === 0) return null
  const { style } = item.node
  const left = parsePx(style.left)
  const top = parsePx(style.top)
  if (style.position === 'absolute' && left !== null && top !== null) {
    return {
      type: 'setStyle',
      id: item.node.id,
      patch: { left: px(left + dx), top: px(top + dy) },
    }
  }
  return {
    type: 'setStyle',
    id: item.node.id,
    patch: placement({ x, y, w: item.rect.w, h: item.rect.h }),
  }
}

// `bounds` is the reference box: the union of the items when several are
// selected, the parent box when only one is.
export function planAlign(items: readonly PlacedNode[], mode: AlignMode, bounds: Rect): DesignOp[] {
  const ops: DesignOp[] = []
  for (const item of items) {
    const { rect } = item
    let x = rect.x
    let y = rect.y
    switch (mode) {
      case 'left':
        x = bounds.x
        break
      case 'right':
        x = bounds.x + bounds.w - rect.w
        break
      case 'centerH':
        x = bounds.x + (bounds.w - rect.w) / 2
        break
      case 'top':
        y = bounds.y
        break
      case 'bottom':
        y = bounds.y + bounds.h - rect.h
        break
      case 'centerV':
        y = bounds.y + (bounds.h - rect.h) / 2
        break
    }
    const op = planPlaceAt(item, x, y)
    if (op) ops.push(op)
  }
  return ops
}

export function planNudge(items: readonly PlacedNode[], dx: number, dy: number): DesignOp[] {
  const ops: DesignOp[] = []
  for (const item of items) {
    const op = planPlaceAt(item, item.rect.x + dx, item.rect.y + dy)
    if (op) ops.push(op)
  }
  return ops
}

export function alignBounds(items: readonly PlacedNode[], parentRect: Rect): Rect {
  if (items.length > 1) return unionOf(items.map((i) => i.rect))
  return { x: 0, y: 0, w: parentRect.w, h: parentRect.h }
}
