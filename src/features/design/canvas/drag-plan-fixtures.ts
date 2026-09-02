import type { DesignNode, DesignOp } from '@shared/types/design'
import type { DragNode, ParentLayout } from './drag-plan'

// Shared fixtures for the drag-plan tests (move/resize in drag-plan.test.ts,
// reorder/reparent/align in drag-plan-layout.test.ts).

export const BLOCK: ParentLayout = {
  display: 'block',
  flexDirection: 'row',
  flexWrap: 'nowrap',
}
export const ROW: ParentLayout = {
  display: 'flex',
  flexDirection: 'row',
  flexWrap: 'nowrap',
}
export const COLUMN: ParentLayout = {
  display: 'flex',
  flexDirection: 'column',
  flexWrap: 'nowrap',
}
export const WRAP: ParentLayout = {
  display: 'flex',
  flexDirection: 'row',
  flexWrap: 'wrap',
}

export function node(
  id: string,
  style: Record<string, string> = {},
  extra: Partial<DesignNode> = {},
): DesignNode {
  return {
    id,
    tag: 'div',
    kind: 'frame',
    style,
    attrs: {},
    children: [],
    ...extra,
  }
}

export function drag(
  n: DesignNode,
  rect: { x: number; y: number; w: number; h: number },
  parent: DesignNode | null = node('parent'),
  parentLayout: ParentLayout | null = BLOCK,
  parentRect = { x: 0, y: 0, w: 800, h: 600 },
): DragNode {
  return { node: n, rect, parent, parentRect, parentLayout }
}

export function styleOf(ops: DesignOp[], id: string): Record<string, string | null> {
  const op = ops.find((o) => o.type === 'setStyle' && o.id === id)
  if (!op || op.type !== 'setStyle') throw new Error(`no setStyle for ${id}`)
  return op.patch
}
