// Gesture state shared by the canvas: the feedback store SelectionOverlay
// reads (guides, insertion line, drop target, marquee), the gesture shapes
// GestureRunner (gesture-runner.ts) drives, and the host contract the
// per-gesture tick functions (gesture-move.ts) call back into.

import { create } from 'zustand'
import type { DesignTool } from '@/store/designStore'
import type { HitMessage, Rect } from '@shared/design/protocol'
import type { DesignOp } from '@shared/types/design'
import type { ArtboardBridge } from './runtime-bridge'
import type { Point } from './geometry'
import type { DragNode, ResizeHandle } from './drag-plan'
import type { InsertionLine } from './reorder-plan'
import type { SnapGuide } from './snapping'
import type { DropTarget, MovePrep } from './drag-prep'

// ---- overlay feedback ----

export interface GestureFeedback {
  artboardId: string | null
  // Artboard-local rects/lines; the overlay converts to screen space.
  marquee: Rect | null
  drawing: Rect | null
  guides: SnapGuide[]
  insertion: InsertionLine | null
  dropTarget: Rect | null
  active: boolean
}

export interface GestureFeedbackStore extends GestureFeedback {
  update: (patch: Partial<GestureFeedback>) => void
  clear: () => void
}

const IDLE: GestureFeedback = {
  artboardId: null,
  marquee: null,
  drawing: null,
  guides: [],
  insertion: null,
  dropTarget: null,
  active: false,
}

export const useGestureFeedback = create<GestureFeedbackStore>((set) => ({
  ...IDLE,
  update: (patch) => set(patch),
  clear: () => set(IDLE),
}))

// ---- gestures ----

export interface Mods {
  shift: boolean
  alt: boolean
}

export interface PressGesture {
  kind: 'press'
  pointerId: number
  start: Point
  last: Point
  moved: boolean
  tool: DesignTool
  handle: { nodeId: string; handle: ResizeHandle } | null
  hit: HitMessage | null
  shift: boolean
  deep: boolean
  alt: boolean
  // Set while the async snapshot for the drag is being fetched.
  preparing?: boolean
}

export interface MoveGesture {
  kind: 'move'
  pointerId: number
  start: Point
  last: Point
  mods: Mods
  prep: MovePrep
  ids: string[]
  // Post-snap delta of the last tick; what the final commit uses.
  delta: Point
  dirty: boolean
  reorderIndex: number | null
  drop: DropTarget | null
  dropIndex: number
  probeSeq: number
  probing: boolean
}

export interface ResizeGesture {
  kind: 'resize'
  pointerId: number
  start: Point
  last: Point
  mods: Mods
  node: DragNode
  handle: ResizeHandle
  candidates: Rect[]
  delta: Point
  dirty: boolean
}

export interface MarqueeGesture {
  kind: 'marquee'
  pointerId: number
  start: Point
  last: Point
  additive: boolean
}

export interface DrawGesture {
  kind: 'draw'
  pointerId: number
  start: Point
  last: Point
  tool: DesignTool
  target: DropTarget
}

export type Gesture = PressGesture | MoveGesture | ResizeGesture | MarqueeGesture | DrawGesture

export const CLICK_THRESHOLD_PX = 3
export const DEFAULT_DRAW_SIZE = 100

// Which node a plain click lands on: the direct child of the current scope
// (or of the root when there is no scope). Cmd/Ctrl click takes the deepest.
export function resolveClickTarget(
  path: readonly string[],
  scopeId: string | null,
  deep: boolean,
): string | null {
  if (path.length === 0) return null
  if (deep) return path[path.length - 1]
  const scopeIndex = scopeId ? path.indexOf(scopeId) : 0
  const base = scopeIndex === -1 ? 0 : scopeIndex
  return path[base + 1] ?? null
}

// Double click on a container: one level deeper along the hit path, below
// the deepest selected ancestor (Figma's "enter group"). Without a selected
// ancestor it behaves like a plain click. Null when there is nothing deeper.
export function resolveDiveTarget(
  path: readonly string[],
  selectedIds: readonly string[],
  scopeId: string | null,
): { scopeId: string; nodeId: string } | null {
  for (let i = path.length - 1; i >= 0; i--) {
    if (!selectedIds.includes(path[i])) continue
    const next = path[i + 1]
    return next ? { scopeId: path[i], nodeId: next } : null
  }
  const target = resolveClickTarget(path, scopeId, false)
  if (!target) return null
  const parent = path[path.indexOf(target) - 1]
  return parent ? { scopeId: parent, nodeId: target } : null
}

export function gestureFeedback(): GestureFeedbackStore {
  return useGestureFeedback.getState()
}

// What a tick function may ask of the runner that owns the gesture.
export interface GestureHost {
  readonly artboardId: string
  readonly bridge: ArtboardBridge
  isCurrent(g: Gesture): boolean
  scheduleTick(): void
  snapThreshold(): number
  commitTransient(ops: DesignOp[], coalesceKey: string): void
  // Final op of a drag; skipped when nothing changed.
  commit(ops: DesignOp[], summary: string, dirty: boolean): void
}
