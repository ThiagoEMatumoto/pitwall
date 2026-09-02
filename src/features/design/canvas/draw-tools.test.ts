import { describe, expect, it } from 'vitest'
import { applyOps } from '@shared/design/ops'
import type { DesignNode, DesignOp } from '@shared/types/design'
import {
  alignBounds,
  normalizeDrawRect,
  parsePx,
  planAlign,
  planInsertForTool,
  planNudge,
  planToggleAutoLayout,
  planUnwrap,
  planWrapInFrame,
  planZOrder,
} from './draw-tools'

const node = (partial: Partial<DesignNode> & { id: string }): DesignNode => ({
  tag: 'div',
  kind: 'element',
  style: {},
  attrs: {},
  children: [],
  ...partial,
})

const root = (): DesignNode =>
  node({
    id: 'root',
    kind: 'frame',
    children: [
      node({
        id: 'a',
        style: { position: 'absolute', left: '10px', top: '20px' },
      }),
      node({
        id: 'b',
        style: { position: 'absolute', left: '50px', top: '60px' },
      }),
      node({ id: 'c' }),
    ],
  })

const insertOf = (ops: DesignOp[]): Extract<DesignOp, { type: 'insert' }> => {
  const op = ops[0]
  if (op.type !== 'insert') throw new Error('expected insert')
  return op
}

describe('planInsertForTool', () => {
  it('frame: absolute div with light fill and radius', () => {
    const { ops, newId } = planInsertForTool('frame', { x: 5, y: 6, w: 200, h: 100 }, 'root', 3)
    const op = insertOf(ops)
    expect(op.parentId).toBe('root')
    expect(op.index).toBe(3)
    expect(op.node.id).toBe(newId)
    expect(op.node.kind).toBe('frame')
    expect(op.node.style).toMatchObject({
      position: 'absolute',
      left: '5px',
      top: '6px',
      width: '200px',
      height: '100px',
      background: '#f3f4f6',
      'border-radius': '8px',
    })
  })

  it('rect and ellipse are elements; ellipse is round', () => {
    const rect = insertOf(planInsertForTool('rect', { x: 0, y: 0, w: 10, h: 10 }, 'root', 0).ops)
    const ellipse = insertOf(
      planInsertForTool('ellipse', { x: 0, y: 0, w: 10, h: 10 }, 'root', 0).ops,
    )
    expect(rect.node.kind).toBe('element')
    expect(rect.node.style['border-radius']).toBeUndefined()
    expect(ellipse.node.style['border-radius']).toBe('50%')
  })

  it('text: <p> "Text" at 16px; click keeps width auto, drag keeps width', () => {
    const click = insertOf(planInsertForTool('text', { x: 1, y: 2, w: 0, h: 0 }, 'root', 0).ops)
    expect(click.node.tag).toBe('p')
    expect(click.node.kind).toBe('text')
    expect(click.node.text).toBe('Text')
    expect(click.node.style['font-size']).toBe('16px')
    expect(click.node.style.width).toBeUndefined()
    const drag = insertOf(
      planInsertForTool('text', { x: 1, y: 2, w: 120, h: 0 }, 'root', 0, {
        text: 'Hi',
      }).ops,
    )
    expect(drag.node.style.width).toBe('120px')
    expect(drag.node.text).toBe('Hi')
  })

  it('image: <img src> with object-fit cover', () => {
    const op = insertOf(
      planInsertForTool('image', { x: 0, y: 0, w: 40, h: 30 }, 'root', 0, {
        assetUrl: 'pitwall-design://asset/1',
      }).ops,
    )
    expect(op.node.tag).toBe('img')
    expect(op.node.attrs.src).toBe('pitwall-design://asset/1')
    expect(op.node.style['object-fit']).toBe('cover')
  })

  it('a click (zero size) becomes the default 100x100', () => {
    expect(normalizeDrawRect({ x: 3, y: 4, w: 0, h: 0 })).toEqual({
      x: 3,
      y: 4,
      w: 100,
      h: 100,
    })
    const op = insertOf(planInsertForTool('rect', { x: 3, y: 4, w: 0, h: 0 }, 'root', 0).ops)
    expect(op.node.style.width).toBe('100px')
  })

  it('ops apply to a tree', () => {
    const { ops, newId } = planInsertForTool('rect', { x: 0, y: 0, w: 10, h: 10 }, 'root', 1)
    const { tree } = applyOps(root(), ops)
    expect(tree.children.map((c) => c.id)).toEqual(['a', newId, 'b', 'c'])
  })
})

describe('planWrapInFrame / planUnwrap', () => {
  it('wraps items in a frame sized to their union and re-bases their offsets', () => {
    const tree = root()
    const items = [
      { node: tree.children[0], rect: { x: 10, y: 20, w: 30, h: 30 } },
      { node: tree.children[1], rect: { x: 50, y: 60, w: 20, h: 10 } },
    ]
    const { ops, newId } = planWrapInFrame('root', items, 0)
    const { tree: next } = applyOps(tree, ops)
    expect(next.children.map((c) => c.id)).toEqual([newId, 'c'])
    const frame = next.children[0]
    expect(frame.kind).toBe('frame')
    expect(frame.style).toMatchObject({
      left: '10px',
      top: '20px',
      width: '60px',
      height: '50px',
    })
    expect(frame.children.map((c) => c.id)).toEqual(['a', 'b'])
    expect(frame.children[0].style).toMatchObject({
      left: '0px',
      top: '0px',
      width: '30px',
    })
    expect(frame.children[1].style).toMatchObject({
      left: '40px',
      top: '40px',
    })
  })

  it('unwrap restores children to the parent at the frame index with absolute offsets', () => {
    const tree = root()
    const items = [
      { node: tree.children[0], rect: { x: 10, y: 20, w: 30, h: 30 } },
      { node: tree.children[1], rect: { x: 50, y: 60, w: 20, h: 10 } },
    ]
    const grouped = applyOps(tree, planWrapInFrame('root', items, 0).ops).tree
    const frame = grouped.children[0]
    const { tree: next } = applyOps(grouped, planUnwrap(frame, 'root', 0))
    expect(next.children.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(next.children[0].style).toMatchObject({ left: '10px', top: '20px' })
    expect(next.children[1].style).toMatchObject({ left: '50px', top: '60px' })
  })

  it('unwrap of an empty frame just removes it', () => {
    expect(planUnwrap(node({ id: 'f', kind: 'frame' }), 'root', 0)).toEqual([
      { type: 'remove', ids: ['f'] },
    ])
  })
})

describe('planToggleAutoLayout', () => {
  it('turns flex on with column + gap, and off by clearing them', () => {
    const on = planToggleAutoLayout(node({ id: 'x' }))
    expect(on).toEqual({
      type: 'setStyle',
      id: 'x',
      patch: { display: 'flex', gap: '8px', 'flex-direction': 'column' },
    })
    const off = planToggleAutoLayout(node({ id: 'x', style: { display: 'flex', gap: '4px' } }))
    expect(off).toEqual({
      type: 'setStyle',
      id: 'x',
      patch: { display: null, gap: null, 'flex-direction': null },
    })
  })
})

describe('planZOrder', () => {
  const target = { id: 'b', parentId: 'root', index: 1 }

  it('up/down step by one; top/bottom go to the ends', () => {
    expect(planZOrder(target, 'up', 3)).toEqual({
      type: 'move',
      ids: ['b'],
      parentId: 'root',
      index: 2,
    })
    expect(planZOrder(target, 'down', 3)).toEqual({
      type: 'move',
      ids: ['b'],
      parentId: 'root',
      index: 0,
    })
    expect(planZOrder({ ...target, index: 0 }, 'top', 3)?.type === 'move' && true).toBe(true)
    expect(planZOrder({ ...target, index: 0 }, 'top', 3)).toMatchObject({
      index: 2,
    })
    expect(planZOrder({ ...target, index: 2 }, 'bottom', 3)).toMatchObject({
      index: 0,
    })
  })

  it('is a no-op at the boundaries', () => {
    expect(planZOrder({ ...target, index: 2 }, 'up', 3)).toBeNull()
    expect(planZOrder({ ...target, index: 0 }, 'down', 3)).toBeNull()
    expect(planZOrder({ ...target, index: 2 }, 'top', 3)).toBeNull()
  })

  it('moving up really reorders the siblings', () => {
    const { tree } = applyOps(root(), [planZOrder(target, 'up', 3)!])
    expect(tree.children.map((c) => c.id)).toEqual(['a', 'c', 'b'])
  })
})

describe('planAlign / planNudge', () => {
  const a = {
    node: node({
      id: 'a',
      style: { position: 'absolute', left: '10px', top: '20px' },
    }),
    rect: { x: 10, y: 20, w: 30, h: 30 },
  }
  const b = {
    node: node({
      id: 'b',
      style: { position: 'absolute', left: '50px', top: '60px' },
    }),
    rect: { x: 50, y: 60, w: 20, h: 10 },
  }

  it('aligns several items against their union', () => {
    const bounds = alignBounds([a, b], { x: 0, y: 0, w: 500, h: 500 })
    expect(bounds).toEqual({ x: 10, y: 20, w: 60, h: 50 })
    expect(planAlign([a, b], 'right', bounds)).toEqual([
      { type: 'setStyle', id: 'a', patch: { left: '40px', top: '20px' } },
    ])
    expect(planAlign([a, b], 'centerV', bounds)).toEqual([
      { type: 'setStyle', id: 'a', patch: { left: '10px', top: '30px' } },
      { type: 'setStyle', id: 'b', patch: { left: '50px', top: '40px' } },
    ])
  })

  it('aligns a single item against the parent box', () => {
    const bounds = alignBounds([a], { x: 7, y: 9, w: 200, h: 100 })
    expect(bounds).toEqual({ x: 0, y: 0, w: 200, h: 100 })
    expect(planAlign([a], 'bottom', bounds)).toEqual([
      { type: 'setStyle', id: 'a', patch: { left: '10px', top: '70px' } },
    ])
    expect(planAlign([a], 'left', bounds)).toEqual([
      { type: 'setStyle', id: 'a', patch: { left: '0px', top: '20px' } },
    ])
  })

  it('nudges by delta and shifts offsets, not rects', () => {
    const c = {
      node: node({
        id: 'c',
        style: { position: 'absolute', left: '100px', top: '5px' },
      }),
      rect: { x: 90, y: 5, w: 10, h: 10 },
    }
    expect(planNudge([c], -1, 10)).toEqual([
      { type: 'setStyle', id: 'c', patch: { left: '99px', top: '15px' } },
    ])
  })

  it('a static node becomes absolute at its current box', () => {
    const s = { node: node({ id: 's' }), rect: { x: 12, y: 8, w: 40, h: 16 } }
    expect(planNudge([s], 1, 0)).toEqual([
      {
        type: 'setStyle',
        id: 's',
        patch: {
          position: 'absolute',
          left: '13px',
          top: '8px',
          width: '40px',
          height: '16px',
        },
      },
    ])
    expect(planNudge([s], 0, 0)).toEqual([])
  })

  it('parsePx', () => {
    expect(parsePx('12px')).toBe(12)
    expect(parsePx('-1.5px')).toBe(-1.5)
    expect(parsePx('auto')).toBeNull()
    expect(parsePx(undefined)).toBeNull()
  })
})
