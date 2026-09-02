import { describe, expect, it } from 'vitest'
import type { DesignNode, DesignOp } from '@shared/types/design'
import {
  handleAt,
  planAlign,
  planDistribute,
  planMove,
  planNudge,
  planReparent,
  planResize,
  resizeRect,
  type DragNode,
  type ParentLayout,
} from './drag-plan'
import { planReorder } from './reorder-plan'

const BLOCK: ParentLayout = {
  display: 'block',
  flexDirection: 'row',
  flexWrap: 'nowrap',
}
const ROW: ParentLayout = {
  display: 'flex',
  flexDirection: 'row',
  flexWrap: 'nowrap',
}
const COLUMN: ParentLayout = {
  display: 'flex',
  flexDirection: 'column',
  flexWrap: 'nowrap',
}
const WRAP: ParentLayout = {
  display: 'flex',
  flexDirection: 'row',
  flexWrap: 'wrap',
}

function node(
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

function drag(
  n: DesignNode,
  rect: { x: number; y: number; w: number; h: number },
  parent: DesignNode | null = node('parent'),
  parentLayout: ParentLayout | null = BLOCK,
  parentRect = { x: 0, y: 0, w: 800, h: 600 },
): DragNode {
  return { node: n, rect, parent, parentRect, parentLayout }
}

function styleOf(ops: DesignOp[], id: string): Record<string, string | null> {
  const op = ops.find((o) => o.type === 'setStyle' && o.id === id)
  if (!op || op.type !== 'setStyle') throw new Error(`no setStyle for ${id}`)
  return op.patch
}

describe('planMove', () => {
  it('shifts an absolute node by the delta from its own left/top', () => {
    const d = drag(node('a', { position: 'absolute', left: '10px', top: '20px' }), {
      x: 30,
      y: 40,
      w: 50,
      h: 50,
    })
    const ops = planMove([d], 15, -5)
    expect(ops).toHaveLength(1)
    expect(styleOf(ops, 'a')).toEqual({ left: '25px', top: '15px' })
  })

  it('makes a static child absolute at its rect relative to the parent and positions the frame', () => {
    const parent = node('p')
    const d = drag(node('a'), { x: 130, y: 240, w: 50, h: 50 }, parent, BLOCK, {
      x: 100,
      y: 200,
      w: 400,
      h: 300,
    })
    const ops = planMove([d], 10, 10)
    expect(styleOf(ops, 'p')).toEqual({ position: 'relative' })
    expect(styleOf(ops, 'a')).toEqual({
      position: 'absolute',
      left: '40px',
      top: '50px',
    })
  })

  it('does not touch a parent that is already positioned or not a frame', () => {
    const positioned = node('p', { position: 'relative' })
    const ops = planMove([drag(node('a'), { x: 0, y: 0, w: 10, h: 10 }, positioned)], 1, 1)
    expect(ops.map((o) => (o.type === 'setStyle' ? o.id : ''))).toEqual(['a'])
    const text = node('t', {}, { kind: 'text' })
    const ops2 = planMove([drag(node('a'), { x: 0, y: 0, w: 10, h: 10 }, text)], 1, 1)
    expect(ops2.map((o) => (o.type === 'setStyle' ? o.id : ''))).toEqual(['a'])
  })

  it('drops right/bottom when a right-anchored node gains left/top', () => {
    const d = drag(node('a', { position: 'absolute', right: '0px', bottom: '0px' }), {
      x: 700,
      y: 500,
      w: 100,
      h: 100,
    })
    expect(styleOf(planMove([d], -10, -10), 'a')).toEqual({
      left: '690px',
      top: '490px',
      right: null,
      bottom: null,
    })
  })

  it('skips flex children, locked nodes and the root', () => {
    const flexChild = drag(node('f'), { x: 0, y: 0, w: 10, h: 10 }, node('p'), ROW)
    const locked = drag(node('l', {}, { locked: true }), {
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    const root = drag(node('r'), { x: 0, y: 0, w: 10, h: 10 }, null, null, null as never)
    expect(planMove([flexChild, locked, root], 5, 5)).toEqual([])
  })

  it('planNudge is a move by the same delta', () => {
    const d = drag(node('a', { position: 'absolute', left: '0px', top: '0px' }), {
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    expect(planNudge([d], 0, -10)).toEqual(planMove([d], 0, -10))
  })
})

describe('resizeRect', () => {
  const start = { x: 100, y: 100, w: 200, h: 100 }

  it('east/south grow from the top-left; north/west move the origin', () => {
    expect(resizeRect(start, 'se', 20, 10)).toEqual({
      x: 100,
      y: 100,
      w: 220,
      h: 110,
    })
    expect(resizeRect(start, 'nw', 20, 10)).toEqual({
      x: 120,
      y: 110,
      w: 180,
      h: 90,
    })
    expect(resizeRect(start, 'n', 0, -10)).toEqual({
      x: 100,
      y: 90,
      w: 200,
      h: 110,
    })
  })

  it('Shift keeps the aspect ratio (dominant axis wins on corners)', () => {
    expect(resizeRect(start, 'se', 40, 0, { shift: true })).toEqual({
      x: 100,
      y: 100,
      w: 240,
      h: 120,
    })
    expect(resizeRect(start, 'e', 40, 0, { shift: true })).toEqual({
      x: 100,
      y: 100,
      w: 240,
      h: 120,
    })
    expect(resizeRect(start, 's', 0, 50, { shift: true })).toEqual({
      x: 100,
      y: 100,
      w: 300,
      h: 150,
    })
  })

  it('Alt resizes from the center', () => {
    expect(resizeRect(start, 'e', 10, 0, { alt: true })).toEqual({
      x: 90,
      y: 100,
      w: 220,
      h: 100,
    })
    expect(resizeRect(start, 'nw', 10, 10, { alt: true })).toEqual({
      x: 110,
      y: 110,
      w: 180,
      h: 80,
    })
  })

  it('never collapses below the minimum size', () => {
    const r = resizeRect(start, 'w', 500, 0)
    expect(r.w).toBe(1)
    expect(r.x).toBe(299)
  })
})

describe('planResize', () => {
  it('writes width/height and, for absolute nodes, the moved left/top', () => {
    const d = drag(node('a', { position: 'absolute', left: '10px', top: '10px' }), {
      x: 10,
      y: 10,
      w: 100,
      h: 50,
    })
    expect(styleOf(planResize(d, 'nw', 5, 5), 'a')).toEqual({
      width: '95px',
      height: '45px',
      left: '15px',
      top: '15px',
    })
    expect(styleOf(planResize(d, 'se', 5, 5), 'a')).toEqual({
      width: '105px',
      height: '55px',
    })
  })

  it('only sizes a static node even from a north/west handle', () => {
    const d = drag(node('a'), { x: 10, y: 10, w: 100, h: 50 })
    expect(styleOf(planResize(d, 'nw', 5, 5), 'a')).toEqual({
      width: '95px',
      height: '45px',
    })
  })

  it('turns a filling flex child into a fixed one', () => {
    const d = drag(node('a', { flex: '1 1 0%' }), { x: 0, y: 0, w: 100, h: 50 }, node('p'), ROW)
    expect(styleOf(planResize(d, 'e', 20, 0), 'a')).toEqual({
      width: '120px',
      height: '50px',
      flex: 'none',
      flexGrow: null,
      flexShrink: null,
      flexBasis: null,
    })
    const fixed = drag(node('b', { flex: 'none' }), { x: 0, y: 0, w: 100, h: 50 }, node('p'), ROW)
    expect(styleOf(planResize(fixed, 'e', 20, 0), 'b')).toEqual({
      width: '120px',
      height: '50px',
    })
  })

  it('applies Shift and Alt', () => {
    const d = drag(node('a', { position: 'absolute', left: '100px', top: '100px' }), {
      x: 100,
      y: 100,
      w: 200,
      h: 100,
    })
    expect(styleOf(planResize(d, 'e', 40, 0, { shift: true }), 'a')).toEqual({
      width: '240px',
      height: '120px',
    })
    expect(styleOf(planResize(d, 'e', 10, 0, { alt: true }), 'a')).toEqual({
      width: '220px',
      height: '100px',
      left: '90px',
    })
  })
})

describe('handleAt', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 }
  it('finds the nearest handle within the radius', () => {
    expect(handleAt({ x: 2, y: 2 }, rect, 6)).toBe('nw')
    expect(handleAt({ x: 50, y: 99 }, rect, 6)).toBe('s')
    expect(handleAt({ x: 103, y: 50 }, rect, 6)).toBe('e')
    expect(handleAt({ x: 50, y: 50 }, rect, 6)).toBeNull()
  })
})

describe('planReorder', () => {
  const parentRect = { x: 0, y: 0, w: 400, h: 400 }
  const row = [
    { id: 'a', rect: { x: 0, y: 0, w: 100, h: 40 } },
    { id: 'b', rect: { x: 100, y: 0, w: 100, h: 40 } },
    { id: 'c', rect: { x: 200, y: 0, w: 100, h: 40 } },
  ]

  it('row: index from x midpoints, ignoring the moving node', () => {
    expect(planReorder(row, ROW, { x: 10, y: 20 }, ['c'], parentRect).index).toBe(0)
    expect(planReorder(row, ROW, { x: 140, y: 20 }, ['c'], parentRect).index).toBe(1)
    expect(planReorder(row, ROW, { x: 260, y: 20 }, ['a'], parentRect).index).toBe(2)
  })

  it('row: insertion line sits on the edge of the anchor sibling', () => {
    expect(planReorder(row, ROW, { x: 140, y: 20 }, ['c'], parentRect).line).toEqual({
      x1: 100,
      y1: 0,
      x2: 100,
      y2: 40,
    })
    expect(planReorder(row, ROW, { x: 260, y: 20 }, ['a'], parentRect).line).toEqual({
      x1: 300,
      y1: 0,
      x2: 300,
      y2: 40,
    })
  })

  it('row-reverse flips the comparison and the line side', () => {
    const reverse: ParentLayout = { ...ROW, flexDirection: 'row-reverse' }
    const items = [
      { id: 'a', rect: { x: 200, y: 0, w: 100, h: 40 } },
      { id: 'b', rect: { x: 100, y: 0, w: 100, h: 40 } },
    ]
    const plan = planReorder(items, reverse, { x: 290, y: 20 }, ['x'], parentRect)
    expect(plan.index).toBe(0)
    expect(plan.line).toEqual({ x1: 300, y1: 0, x2: 300, y2: 40 })
  })

  it('column: index from y midpoints', () => {
    const col = [
      { id: 'a', rect: { x: 0, y: 0, w: 100, h: 50 } },
      { id: 'b', rect: { x: 0, y: 50, w: 100, h: 50 } },
    ]
    expect(planReorder(col, COLUMN, { x: 10, y: 60 }, ['x'], parentRect)).toEqual({
      index: 1,
      line: { x1: 0, y1: 50, x2: 100, y2: 50 },
    })
    expect(planReorder(col, COLUMN, { x: 10, y: 99 }, ['x'], parentRect).index).toBe(2)
  })

  it('wrap: picks the line by y, then the slot by x', () => {
    const grid = [
      { id: 'a', rect: { x: 0, y: 0, w: 100, h: 40 } },
      { id: 'b', rect: { x: 100, y: 0, w: 100, h: 40 } },
      { id: 'c', rect: { x: 0, y: 40, w: 100, h: 40 } },
      { id: 'd', rect: { x: 100, y: 40, w: 100, h: 40 } },
    ]
    expect(planReorder(grid, WRAP, { x: 120, y: 60 }, ['x'], parentRect).index).toBe(3)
    expect(planReorder(grid, WRAP, { x: 20, y: 60 }, ['x'], parentRect).index).toBe(2)
    expect(planReorder(grid, WRAP, { x: 190, y: 10 }, ['x'], parentRect).index).toBe(2)
    expect(planReorder(grid, WRAP, { x: 190, y: 500 }, ['x'], parentRect).index).toBe(4)
  })

  it('empty parent: index 0 with the line on the parent edge', () => {
    expect(planReorder([], ROW, { x: 5, y: 5 }, [], { x: 10, y: 10, w: 100, h: 50 })).toEqual({
      index: 0,
      line: { x1: 10, y1: 10, x2: 10, y2: 60 },
    })
  })
})

describe('planReparent', () => {
  const nodes = [
    drag(
      node('a', {
        position: 'absolute',
        left: '10px',
        top: '10px',
        right: '5px',
      }),
      { x: 10, y: 10, w: 50, h: 50 },
    ),
  ]

  it('moves into a flex target with just the move op', () => {
    const ops = planReparent(
      nodes,
      {
        id: 'flex',
        rect: { x: 0, y: 0, w: 100, h: 100 },
        layout: ROW,
        index: 2,
      },
      0,
      0,
    )
    expect(ops).toEqual([{ type: 'move', ids: ['a'], parentId: 'flex', index: 2 }])
  })

  it('moves into a block target and repositions relative to the target rect', () => {
    const target = {
      id: 'box',
      rect: { x: 200, y: 300, w: 400, h: 400 },
      layout: BLOCK,
      index: 0,
    }
    const ops = planReparent(nodes, target, 250, 350)
    expect(ops[0]).toEqual({
      type: 'move',
      ids: ['a'],
      parentId: 'box',
      index: 0,
    })
    expect(styleOf(ops, 'a')).toEqual({
      position: 'absolute',
      left: '60px',
      top: '60px',
      right: null,
    })
  })

  it('ignores locked nodes', () => {
    const locked = [drag(node('l', {}, { locked: true }), { x: 0, y: 0, w: 1, h: 1 })]
    expect(
      planReparent(
        locked,
        { id: 'x', rect: { x: 0, y: 0, w: 1, h: 1 }, layout: BLOCK, index: 0 },
        0,
        0,
      ),
    ).toEqual([])
  })
})

describe('planAlign / planDistribute', () => {
  const abs = (id: string, x: number, y: number, w: number, h: number): DragNode =>
    drag(
      node(id, { position: 'absolute', left: `${x}px`, top: `${y}px` }),
      { x, y, w, h },
      node('p', { position: 'relative' }),
    )

  it('a single node aligns to its parent', () => {
    const d = abs('a', 10, 10, 100, 50)
    expect(styleOf(planAlign([d], 'right'), 'a')).toEqual({ left: '700px' })
    expect(styleOf(planAlign([d], 'centerV'), 'a')).toEqual({ top: '275px' })
  })

  it('several nodes align to their common bounds', () => {
    const a = abs('a', 10, 10, 100, 50)
    const b = abs('b', 200, 100, 20, 20)
    const ops = planAlign([a, b], 'left')
    expect(ops.map((o) => (o.type === 'setStyle' ? o.id : ''))).toEqual(['a', 'b'])
    expect(styleOf(ops, 'b')).toEqual({ left: '10px' })
    expect(styleOf(planAlign([a, b], 'bottom'), 'a')).toEqual({ top: '70px' })
  })

  it('distributes the inner nodes with even gaps', () => {
    const a = abs('a', 0, 0, 10, 10)
    const b = abs('b', 15, 0, 10, 10)
    const c = abs('c', 90, 0, 10, 10)
    const ops = planDistribute([c, a, b], 'x')
    expect(ops).toHaveLength(1)
    expect(styleOf(ops, 'b')).toEqual({ left: '45px' })
    expect(planDistribute([a, b], 'x')).toEqual([])
  })
})
