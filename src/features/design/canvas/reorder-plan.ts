// Reorder inside a flex parent: the pointer against sibling midpoints on the
// main axis (rows of siblings first when the parent wraps) gives the index a
// `move` op expects plus the insertion line the overlay draws. Artboard-local.

import type { Rect } from '@shared/design/protocol'
import type { Point } from './geometry'
import type { ParentLayout } from './drag-plan'

export interface InsertionLine {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface ReorderPlan {
  // Index among the remaining siblings (what the `move` op expects).
  index: number
  line: InsertionLine
}

interface SiblingRect {
  id: string
  rect: Rect
}

interface Axis {
  main: (r: Rect) => [number, number]
  cross: (r: Rect) => [number, number]
}

function axisFor(horizontal: boolean): Axis {
  return horizontal
    ? { main: (r) => [r.x, r.x + r.w], cross: (r) => [r.y, r.y + r.h] }
    : { main: (r) => [r.y, r.y + r.h], cross: (r) => [r.x, r.x + r.w] }
}

// Wrapped flex lays out lines along the cross axis; siblings are in DOM order,
// so a new line starts when an item begins past the current line's end.
function groupLines(items: SiblingRect[], axis: Axis, wrap: boolean): SiblingRect[][] {
  if (!wrap || items.length === 0) return items.length ? [items] : []
  const lines: SiblingRect[][] = [[items[0]]]
  let lineEnd = axis.cross(items[0].rect)[1]
  for (const item of items.slice(1)) {
    const [start, end] = axis.cross(item.rect)
    if (start >= lineEnd - 1) {
      lines.push([item])
      lineEnd = end
    } else {
      lines[lines.length - 1].push(item)
      lineEnd = Math.max(lineEnd, end)
    }
  }
  return lines
}

function lineAt(
  horizontal: boolean,
  reversed: boolean,
  item: SiblingRect | null,
  before: boolean,
  fallback: Rect,
): InsertionLine {
  const rect = item?.rect ?? fallback
  // In *-reverse the DOM-first item sits at the far end, so "before" flips side.
  const atStart = item ? before !== reversed : true
  if (horizontal) {
    const x = atStart ? rect.x : rect.x + rect.w
    return { x1: x, y1: rect.y, x2: x, y2: rect.y + rect.h }
  }
  const y = atStart ? rect.y : rect.y + rect.h
  return { x1: rect.x, y1: y, x2: rect.x + rect.w, y2: y }
}

export function planReorder(
  siblings: readonly SiblingRect[],
  layout: ParentLayout,
  pointer: Point,
  movingIds: readonly string[],
  parentRect: Rect,
): ReorderPlan {
  const others = siblings.filter((s) => !movingIds.includes(s.id))
  const horizontal = layout.flexDirection.startsWith('row')
  const reversed = layout.flexDirection.endsWith('-reverse')
  const wrap = layout.flexWrap === 'wrap' || layout.flexWrap === 'wrap-reverse'
  const axis = axisFor(horizontal)
  const lines = groupLines(others, axis, wrap)
  if (lines.length === 0) {
    return {
      index: 0,
      line: lineAt(horizontal, reversed, null, true, parentRect),
    }
  }
  const pCross = horizontal ? pointer.y : pointer.x
  const pMain = horizontal ? pointer.x : pointer.y
  let lineIndex = lines.findIndex(
    (line) => pCross < Math.max(...line.map((s) => axis.cross(s.rect)[1])),
  )
  if (lineIndex === -1) lineIndex = lines.length - 1
  const line = lines[lineIndex]
  const isAfter = (s: SiblingRect): boolean => {
    const [a, b] = axis.main(s.rect)
    const mid = (a + b) / 2
    return reversed ? pMain > mid : pMain < mid
  }
  let local = line.findIndex(isAfter)
  if (local === -1) local = line.length
  const offset = lines.slice(0, lineIndex).reduce((n, l) => n + l.length, 0)
  const before = local < line.length
  const anchor = before ? line[local] : line[line.length - 1]
  return {
    index: offset + local,
    line: lineAt(horizontal, reversed, anchor, before, parentRect),
  }
}
