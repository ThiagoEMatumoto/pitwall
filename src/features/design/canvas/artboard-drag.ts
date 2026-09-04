// Pure planners for the artboard box itself: the handle resize, the body
// drag and the frame drawn on empty canvas. Everything here is canvas px
// (meta.x/y/width/height) and emits `setArtboard`, unlike drag-plan.ts,
// which plans styles for a node inside an artboard.

import { ARTBOARD_MIN_PX, DEFAULT_ARTBOARD_HEIGHT_PX, clampArtboardSize } from '@shared/design/safety'
import type { ArtboardPatch } from '@shared/design/ops'
import type { Rect } from '@shared/design/protocol'
import type { ArtboardPreset, ArtboardSizing, DesignArtboard, DesignOp } from '@shared/types/design'
import { RESIZE_HANDLES, resizeRect, type ResizeHandle, type ResizeMods } from './drag-plan'
import { artboardBounds, type ArtboardPlacement } from './geometry'

export type ArtboardBox = ArtboardPlacement & { sizing?: ArtboardSizing }

// A flow artboard's height belongs to its content (the runtime measures it),
// so only the side handles are offered — the same rule the inspector follows
// when it hides the H field.
const FLOW_HANDLES: readonly ResizeHandle[] = ['w', 'e']

export function artboardHandles(box: ArtboardBox): readonly ResizeHandle[] {
  return box.sizing === 'flow' ? FLOW_HANDLES : RESIZE_HANDLES
}

// Where the box lands when `handle` travels (dx, dy). The size is clamped to
// the artboard limits first and only then does the fixed edge decide x/y, so
// a clamped edge stops instead of dragging the opposite one along.
export function resizeArtboardBox(
  box: ArtboardBox,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  mods: ResizeMods = {},
): ArtboardPlacement {
  const raw = resizeRect({ x: box.x, y: box.y, w: box.width, h: box.height }, handle, dx, dy, mods)
  const width = clampArtboardSize(raw.w)
  const height = box.sizing === 'flow' ? box.height : clampArtboardSize(raw.h)
  if (mods.alt) {
    return {
      x: Math.round(box.x - (width - box.width) / 2),
      y: Math.round(box.y - (height - box.height) / 2),
      width,
      height,
    }
  }
  return {
    x: handle.includes('w') ? box.x + box.width - width : box.x,
    y: handle.includes('n') ? box.y + box.height - height : box.y,
    width,
    height,
  }
}

export function planArtboardResize(
  box: ArtboardBox,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  mods: ResizeMods = {},
): DesignOp[] {
  const next = resizeArtboardBox(box, handle, dx, dy, mods)
  const patch: ArtboardPatch = {}
  if (next.x !== box.x) patch.x = next.x
  if (next.y !== box.y) patch.y = next.y
  if (next.width !== box.width) patch.width = next.width
  if (next.height !== box.height) patch.height = next.height
  return Object.keys(patch).length === 0 ? [] : [{ type: 'setArtboard', patch }]
}

export function planArtboardMove(box: ArtboardPlacement, dx: number, dy: number): DesignOp[] {
  const x = Math.round(box.x + dx)
  const y = Math.round(box.y + dy)
  if (x === box.x && y === box.y) return []
  return [{ type: 'setArtboard', patch: { x, y } }]
}

// The other artboards on the same page: what a dragged one snaps to.
export function siblingBounds(metas: readonly DesignArtboard[], self: DesignArtboard): Rect[] {
  return metas.filter((m) => m.id !== self.id && m.pageId === self.pageId).map(artboardBounds)
}

// ---- drawing a frame on empty canvas ----

export const DEFAULT_DRAWN_ARTBOARD = {
  width: 800,
  height: DEFAULT_ARTBOARD_HEIGHT_PX,
}

// Label and sizing of a frame drawn with the mouse; the drag gives its box.
export const DRAWN_ARTBOARD_PRESET: ArtboardPreset = {
  id: 'drawn',
  label: 'Frame',
  group: 'desktop',
  ...DEFAULT_DRAWN_ARTBOARD,
  sizing: 'fixed',
}

// A drag under the artboard minimum on either side was a stray click, not a
// frame: it falls back to the default box anchored at the drag's top-left.
export function normalizeDrawnArtboard(rect: Rect): ArtboardPlacement {
  const x = Math.round(rect.x)
  const y = Math.round(rect.y)
  if (rect.w < ARTBOARD_MIN_PX || rect.h < ARTBOARD_MIN_PX) {
    return { x, y, ...DEFAULT_DRAWN_ARTBOARD }
  }
  return { x, y, width: clampArtboardSize(rect.w), height: clampArtboardSize(rect.h) }
}
