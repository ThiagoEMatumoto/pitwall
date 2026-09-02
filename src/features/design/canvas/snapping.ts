// Pure snapping for move/resize: the moving rect's L/C/R (x) and T/C/B (y)
// lines against the same lines of candidates (siblings + parent). Returns the
// smallest correction within the threshold per axis plus the guide lines the
// overlay draws. All coordinates are artboard-local px.

import type { Rect } from '@shared/design/protocol'

export type SnapEdge = 'start' | 'center' | 'end'

export interface SnapGuide {
  // A guide on axis 'x' is a vertical line at x=at spanning y from..to.
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
}

export interface SnapResult {
  dx: number
  dy: number
  guides: SnapGuide[]
}

export interface SnapOptions {
  // Which lines of the moving rect may snap (resize snaps only the dragged edge).
  edgesX?: readonly SnapEdge[]
  edgesY?: readonly SnapEdge[]
}

export const SNAP_THRESHOLD_PX = 6
const ALL_EDGES: readonly SnapEdge[] = ['start', 'center', 'end']
const EPSILON = 0.01

interface Line {
  edge: SnapEdge
  at: number
}

function linesOf(min: number, size: number, edges: readonly SnapEdge[]): Line[] {
  const at: Record<SnapEdge, number> = {
    start: min,
    center: min + size / 2,
    end: min + size,
  }
  return edges.map((edge) => ({ edge, at: at[edge] }))
}

interface AxisSnap {
  delta: number
  at: number
  matched: Rect[]
}

// Best correction on one axis: the candidate line closest to any moving line.
function snapAxis(
  moving: Line[],
  candidates: readonly Rect[],
  axis: 'x' | 'y',
  threshold: number,
): AxisSnap | null {
  let best: AxisSnap | null = null
  for (const candidate of candidates) {
    const cLines =
      axis === 'x'
        ? linesOf(candidate.x, candidate.w, ALL_EDGES)
        : linesOf(candidate.y, candidate.h, ALL_EDGES)
    for (const m of moving) {
      for (const c of cLines) {
        const delta = c.at - m.at
        const dist = Math.abs(delta)
        if (dist > threshold) continue
        if (!best || dist < Math.abs(best.delta) - EPSILON) {
          best = { delta, at: c.at, matched: [candidate] }
        } else if (Math.abs(dist - Math.abs(best.delta)) <= EPSILON && best.at === c.at) {
          if (!best.matched.includes(candidate)) best.matched.push(candidate)
        }
      }
    }
  }
  return best
}

function guideFor(axis: 'x' | 'y', snap: AxisSnap, moved: Rect): SnapGuide {
  const rects = [moved, ...snap.matched]
  const from = Math.min(...rects.map((r) => (axis === 'x' ? r.y : r.x)))
  const to = Math.max(...rects.map((r) => (axis === 'x' ? r.y + r.h : r.x + r.w)))
  return { axis, at: snap.at, from, to }
}

export function computeSnap(
  moving: Rect,
  candidates: readonly Rect[],
  threshold = SNAP_THRESHOLD_PX,
  opts: SnapOptions = {},
): SnapResult {
  const edgesX = opts.edgesX ?? ALL_EDGES
  const edgesY = opts.edgesY ?? ALL_EDGES
  const sx = edgesX.length
    ? snapAxis(linesOf(moving.x, moving.w, edgesX), candidates, 'x', threshold)
    : null
  const sy = edgesY.length
    ? snapAxis(linesOf(moving.y, moving.h, edgesY), candidates, 'y', threshold)
    : null
  const dx = sx?.delta ?? 0
  const dy = sy?.delta ?? 0
  const moved: Rect = { ...moving, x: moving.x + dx, y: moving.y + dy }
  const guides: SnapGuide[] = []
  if (sx) guides.push(guideFor('x', sx, moved))
  if (sy) guides.push(guideFor('y', sy, moved))
  return { dx, dy, guides }
}
