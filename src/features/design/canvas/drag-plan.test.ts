import { describe, expect, it } from 'vitest'
import { handleAt, planMove, planNudge, planResize, resizeRect } from './drag-plan'
import { BLOCK, ROW, drag, node, styleOf } from './drag-plan-fixtures'

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
