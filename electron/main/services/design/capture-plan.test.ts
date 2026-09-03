import { describe, expect, it } from 'vitest'
import {
  assertCaptureBudget,
  captureTimeoutMs,
  BitmapComposer,
  exceedsCaptureBudget,
  planCaptureTiles,
} from './capture-plan'
import { CAPTURE_TILE_MAX_PX, MAX_CAPTURE_PIXELS } from '../../../../shared/design/safety'

describe('planCaptureTiles', () => {
  // A single full-page clip is copied from the native-scale surface by
  // Chromium's offscreen renderer (the emulated deviceScaleFactor is
  // ignored), so even a short artboard is split in two.
  it('splits a short artboard in two halves, never one tile', () => {
    const plan = planCaptureTiles({ width: 1440, height: 900, scale: 2 })
    expect(plan.tiles).toEqual([
      { y: 0, h: 450 },
      { y: 450, h: 450 },
    ])
    expect(plan).toMatchObject({ outW: 2880, outH: 1800, pixels: 2880 * 1800 })
  })

  it('keeps a 1px artboard in one tile', () => {
    expect(planCaptureTiles({ width: 10, height: 1, scale: 1 }).tiles).toEqual([{ y: 0, h: 1 }])
  })

  it('slices a tall artboard into tiles no taller than the max', () => {
    const plan = planCaptureTiles({ width: 1440, height: 9000, scale: 1 })
    expect(plan.tiles).toEqual([
      { y: 0, h: 4096 },
      { y: 4096, h: 4096 },
      { y: 8192, h: 808 },
    ])
    expect(plan.tiles.reduce((s, t) => s + t.h, 0)).toBe(9000)
    expect(plan.outH).toBe(9000)
  })

  it('splits exactly the tile max into two halves', () => {
    const plan = planCaptureTiles({ width: 800, height: CAPTURE_TILE_MAX_PX, scale: 1 })
    expect(plan.tiles.map((t) => t.h)).toEqual([2048, 2048])
  })

  it('honours a custom tileMax', () => {
    const plan = planCaptureTiles({ width: 10, height: 25, scale: 1, tileMax: 10 })
    expect(plan.tiles.map((t) => t.h)).toEqual([10, 10, 5])
  })

  it('rounds fractional rects up so nothing is cropped', () => {
    const plan = planCaptureTiles({ width: 100.4, height: 50.2, scale: 2 })
    expect(plan.tiles).toEqual([
      { y: 0, h: 26 },
      { y: 26, h: 25 },
    ])
    expect(plan).toMatchObject({ outW: 202, outH: 102 })
  })
})

describe('capture budget', () => {
  it('accepts 4K at 3x and rejects it at 4x', () => {
    const ok = planCaptureTiles({ width: 3840, height: 2160, scale: 3 })
    expect(exceedsCaptureBudget(ok)).toBe(false)
    expect(() => assertCaptureBudget({ width: 3840, height: 2160, scale: 3 }, ok)).not.toThrow()

    const input = { width: 3840, height: 2160, scale: 4 }
    const tooBig = planCaptureTiles(input)
    expect(tooBig.pixels).toBeGreaterThan(MAX_CAPTURE_PIXELS)
    expect(exceedsCaptureBudget(tooBig)).toBe(true)
    expect(() => assertCaptureBudget(input, tooBig)).toThrow(/above the 120 Mpx budget/)
  })
})

describe('captureTimeoutMs', () => {
  it('grows with the tile count', () => {
    expect(captureTimeoutMs(1)).toBe(12_000)
    expect(captureTimeoutMs(3)).toBe(16_000)
    expect(captureTimeoutMs(0)).toBe(10_000)
  })
})

describe('BitmapComposer', () => {
  const outW = 3
  function row(b: number, g: number, r: number, a = 255): number[] {
    return Array.from({ length: outW }, () => [b, g, r, a]).flat()
  }

  it('copies BGRA rows in order into one bitmap', () => {
    const top = Buffer.from([...row(1, 2, 3), ...row(4, 5, 6)])
    const bottom = Buffer.from(row(7, 8, 9))
    const composer = new BitmapComposer(outW, 3)
    composer.append({ bitmap: top, h: 2 })
    composer.append({ bitmap: bottom, h: 1 })
    const out = composer.finish()
    expect(out).toMatchObject({ width: 3, height: 3 })
    expect(out.bitmap.byteLength).toBe(3 * 3 * 4)
    expect([...out.bitmap.subarray(0, 4)]).toEqual([1, 2, 3, 255])
    expect([...out.bitmap.subarray(2 * outW * 4, 2 * outW * 4 + 4)]).toEqual([7, 8, 9, 255])
  })

  it('reports the height that landed, within the slack, never the plan', () => {
    const composer = new BitmapComposer(outW, 2, 1)
    composer.append({ bitmap: Buffer.from(row(1, 1, 1)), h: 1 })
    expect(composer.finish().height).toBe(1)
    composer.append({ bitmap: Buffer.from([...row(2, 2, 2), ...row(3, 3, 3)]), h: 2 })
    const out = composer.finish()
    expect(out.height).toBe(3)
    expect(out.bitmap.byteLength).toBe(3 * outW * 4)
    expect(() => composer.append({ bitmap: Buffer.from(row(4, 4, 4)), h: 1 })).toThrow(
      /tile 2 overflows the planned 3 rows/,
    )
  })

  it('rejects a tile whose byte length does not match its height', () => {
    const composer = new BitmapComposer(outW, 1)
    expect(() => composer.append({ bitmap: Buffer.alloc(5), h: 1 })).toThrow(
      /tile 0 has 5 bytes, expected 12/,
    )
  })

  it('rejects finishing without a tile', () => {
    expect(() => new BitmapComposer(outW, 1).finish()).toThrow(/no tiles/)
  })
})
