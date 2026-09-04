import { describe, expect, it } from 'vitest'
import { ARTBOARD_MAX_PX, ARTBOARD_MIN_PX } from '@shared/design/safety'
import type { DesignOp } from '@shared/types/design'
import { RESIZE_HANDLES } from './drag-plan'
import {
  DEFAULT_DRAWN_ARTBOARD,
  artboardHandles,
  normalizeDrawnArtboard,
  planArtboardMove,
  planArtboardResize,
  resizeArtboardBox,
} from './artboard-drag'

const BOX = { x: 100, y: 200, width: 400, height: 300 }

function patchOf(ops: DesignOp[]): Record<string, unknown> {
  expect(ops).toHaveLength(1)
  const op = ops[0]
  if (op.type !== 'setArtboard') throw new Error(`expected setArtboard, got ${op.type}`)
  return op.patch as Record<string, unknown>
}

describe('resizeArtboardBox', () => {
  // 100px right and 50px down on every handle: the edges the handle owns
  // move, the opposite ones stay put.
  const cases: Array<[string, ReturnType<typeof resizeArtboardBox>]> = [
    ['nw', { x: 200, y: 250, width: 300, height: 250 }],
    ['n', { x: 100, y: 250, width: 400, height: 250 }],
    ['ne', { x: 100, y: 250, width: 500, height: 250 }],
    ['w', { x: 200, y: 200, width: 300, height: 300 }],
    ['e', { x: 100, y: 200, width: 500, height: 300 }],
    ['sw', { x: 200, y: 200, width: 300, height: 350 }],
    ['s', { x: 100, y: 200, width: 400, height: 350 }],
    ['se', { x: 100, y: 200, width: 500, height: 350 }],
  ]

  it.each(cases)('moves the edges of handle %s', (handle, expected) => {
    expect(resizeArtboardBox(BOX, handle as (typeof RESIZE_HANDLES)[number], 100, 50)).toEqual(
      expected,
    )
  })

  it('covers every handle the overlay draws', () => {
    expect(cases.map(([handle]) => handle)).toEqual([...RESIZE_HANDLES])
  })

  it('clamps to the minimum and keeps the opposite edge anchored', () => {
    const box = resizeArtboardBox(BOX, 'se', -1000, -1000)
    expect(box).toEqual({ x: 100, y: 200, width: ARTBOARD_MIN_PX, height: ARTBOARD_MIN_PX })
  })

  it('a clamped edge stops instead of dragging the anchored one along', () => {
    const box = resizeArtboardBox(BOX, 'nw', 1000, 1000)
    // Right/bottom stay at 500/500; the moving edges rest at the minimum.
    expect(box.width).toBe(ARTBOARD_MIN_PX)
    expect(box.height).toBe(ARTBOARD_MIN_PX)
    expect(box.x + box.width).toBe(BOX.x + BOX.width)
    expect(box.y + box.height).toBe(BOX.y + BOX.height)
  })

  it('clamps to the maximum', () => {
    const box = resizeArtboardBox(BOX, 'se', 1e6, 1e6)
    expect(box).toEqual({ x: 100, y: 200, width: ARTBOARD_MAX_PX, height: ARTBOARD_MAX_PX })
  })

  it('alt grows around the center', () => {
    expect(resizeArtboardBox(BOX, 'e', 50, 0, { alt: true })).toEqual({
      x: 50,
      y: 200,
      width: 500,
      height: 300,
    })
  })

  it('leaves the height of a flow artboard to its content', () => {
    const flow = { ...BOX, sizing: 'flow' as const }
    expect(resizeArtboardBox(flow, 'e', 100, 999)).toEqual({
      x: 100,
      y: 200,
      width: 500,
      height: 300,
    })
  })
})

describe('artboardHandles', () => {
  it('offers all eight on a fixed artboard and only the sides on a flow one', () => {
    expect(artboardHandles(BOX)).toEqual(RESIZE_HANDLES)
    expect(artboardHandles({ ...BOX, sizing: 'flow' })).toEqual(['w', 'e'])
  })
})

describe('planArtboardResize', () => {
  it('emits only the fields that changed', () => {
    expect(patchOf(planArtboardResize(BOX, 'e', 100, 50))).toEqual({ width: 500 })
    expect(patchOf(planArtboardResize(BOX, 'nw', 10, 20))).toEqual({
      x: 110,
      y: 220,
      width: 390,
      height: 280,
    })
  })

  it('emits nothing when the box did not move', () => {
    expect(planArtboardResize(BOX, 'se', 0, 0)).toEqual([])
    // Already at the minimum: dragging further inward changes nothing.
    const min = { x: 0, y: 0, width: ARTBOARD_MIN_PX, height: ARTBOARD_MIN_PX }
    expect(planArtboardResize(min, 'se', -100, -100)).toEqual([])
  })
})

describe('planArtboardMove', () => {
  it('rounds the delta onto the box', () => {
    expect(patchOf(planArtboardMove(BOX, 12.4, -3.6))).toEqual({ x: 112, y: 196 })
  })

  it('emits nothing for a sub-pixel drag', () => {
    expect(planArtboardMove(BOX, 0.2, -0.3)).toEqual([])
  })
})

describe('normalizeDrawnArtboard', () => {
  it('keeps a real drag, rounded', () => {
    expect(normalizeDrawnArtboard({ x: 10.4, y: -5.6, w: 320.7, h: 240.2 })).toEqual({
      x: 10,
      y: -6,
      width: 321,
      height: 240,
    })
  })

  it('falls back to the default box when either side is under the minimum', () => {
    const stray = { x: 42, y: 7, w: 0, h: 0 }
    expect(normalizeDrawnArtboard(stray)).toEqual({ x: 42, y: 7, ...DEFAULT_DRAWN_ARTBOARD })
    expect(normalizeDrawnArtboard({ x: 0, y: 0, w: 900, h: ARTBOARD_MIN_PX - 1 })).toEqual({
      x: 0,
      y: 0,
      ...DEFAULT_DRAWN_ARTBOARD,
    })
  })

  it('a drag exactly at the minimum is a frame, not a stray click', () => {
    expect(normalizeDrawnArtboard({ x: 0, y: 0, w: ARTBOARD_MIN_PX, h: ARTBOARD_MIN_PX })).toEqual({
      x: 0,
      y: 0,
      width: ARTBOARD_MIN_PX,
      height: ARTBOARD_MIN_PX,
    })
  })

  it('clamps a drag wider than the capture limit', () => {
    const box = normalizeDrawnArtboard({ x: 0, y: 0, w: 99999, h: 99999 })
    expect(box.width).toBe(ARTBOARD_MAX_PX)
    expect(box.height).toBe(ARTBOARD_MAX_PX)
  })
})
