import { describe, expect, it } from 'vitest'
import {
  planAlign,
  planDistribute,
  planReparent,
  type DragNode,
  type ParentLayout,
} from './drag-plan'
import { planReorder } from './reorder-plan'
import { BLOCK, COLUMN, ROW, WRAP, drag, node, styleOf } from './drag-plan-fixtures'

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
