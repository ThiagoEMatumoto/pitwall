import { describe, expect, it } from 'vitest'
import { computeSnap } from './snapping'

const parent = { x: 0, y: 0, w: 400, h: 300 }
const sibling = { x: 100, y: 50, w: 100, h: 40 }

describe('computeSnap', () => {
  it('returns no correction when nothing is within the threshold', () => {
    const r = computeSnap({ x: 20, y: 110, w: 30, h: 30 }, [parent, sibling], 6)
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it('snaps the left edge to a sibling left edge and draws a vertical guide', () => {
    const r = computeSnap({ x: 104, y: 150, w: 30, h: 30 }, [sibling], 6)
    expect(r.dx).toBe(-4)
    expect(r.dy).toBe(0)
    expect(r.guides).toEqual([{ axis: 'x', at: 100, from: 50, to: 180 }])
  })

  it('snaps centers to centers on both axes', () => {
    const moving = { x: 133, y: 58, w: 40, h: 20 }
    const r = computeSnap(moving, [sibling], 6)
    expect(r.dx).toBe(-3)
    expect(r.dy).toBe(2)
    expect(r.guides.map((g) => [g.axis, g.at])).toEqual([
      ['x', 150],
      ['y', 70],
    ])
  })

  it('snaps the right edge to the parent right edge', () => {
    const r = computeSnap({ x: 365, y: 10, w: 30, h: 30 }, [parent], 6)
    expect(r.dx).toBe(5)
    expect(r.guides[0]).toEqual({ axis: 'x', at: 400, from: 0, to: 300 })
  })

  it('prefers the closest candidate line', () => {
    const near = { x: 203, y: 200, w: 100, h: 10 }
    const far = { x: 196, y: 200, w: 100, h: 10 }
    const r = computeSnap({ x: 200, y: 100, w: 20, h: 10 }, [far, near], 6)
    expect(r.dx).toBe(3)
  })

  it('a guide spans every candidate sharing the snapped line', () => {
    const a = { x: 100, y: 0, w: 10, h: 10 }
    const b = { x: 100, y: 200, w: 10, h: 10 }
    const r = computeSnap({ x: 102, y: 100, w: 20, h: 10 }, [a, b], 6)
    expect(r.guides).toEqual([{ axis: 'x', at: 100, from: 0, to: 210 }])
  })

  it('honours the edge filter used by resize', () => {
    const moving = { x: 0, y: 0, w: 96, h: 96 }
    const r = computeSnap(moving, [{ x: 100, y: 100, w: 10, h: 10 }], 6, {
      edgesX: ['end'],
      edgesY: [],
    })
    expect(r).toMatchObject({ dx: 4, dy: 0 })
    expect(r.guides).toHaveLength(1)
    const none = computeSnap(moving, [{ x: 0, y: 100, w: 10, h: 10 }], 6, {
      edgesX: ['end'],
      edgesY: [],
    })
    expect(none.dx).toBe(0)
  })

  it('scales with the threshold (caller passes 6/zoom)', () => {
    const moving = { x: 110, y: 150, w: 30, h: 30 }
    expect(computeSnap(moving, [sibling], 6).dx).toBe(0)
    expect(computeSnap(moving, [sibling], 12).dx).toBe(-10)
  })
})
