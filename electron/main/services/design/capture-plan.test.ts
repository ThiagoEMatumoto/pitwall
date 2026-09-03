import { describe, expect, it } from 'vitest'
import {
  assertCaptureBudget,
  captureTimeoutMs,
  composeBitmapTiles,
  exceedsCaptureBudget,
  planCaptureTiles,
} from './capture-plan'
import { CAPTURE_TILE_MAX_PX, MAX_CAPTURE_PIXELS } from '../../../../shared/design/safety'

describe('planCaptureTiles', () => {
  it('keeps a short artboard in one tile', () => {
    const plan = planCaptureTiles({ width: 1440, height: 900, scale: 2 })
    expect(plan.tiles).toEqual([{ y: 0, h: 900 }])
    expect(plan).toMatchObject({ outW: 2880, outH: 1800, pixels: 2880 * 1800 })
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

  it('fits exactly the tile max in one tile', () => {
    const plan = planCaptureTiles({ width: 800, height: CAPTURE_TILE_MAX_PX, scale: 1 })
    expect(plan.tiles).toHaveLength(1)
    expect(plan.tiles[0].h).toBe(4096)
  })

  it('honours a custom tileMax', () => {
    const plan = planCaptureTiles({ width: 10, height: 25, scale: 1, tileMax: 10 })
    expect(plan.tiles.map((t) => t.h)).toEqual([10, 10, 5])
  })

  it('rounds fractional rects up so nothing is cropped', () => {
    const plan = planCaptureTiles({ width: 100.4, height: 50.2, scale: 2 })
    expect(plan.tiles).toEqual([{ y: 0, h: 51 }])
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

describe('composeBitmapTiles', () => {
  const outW = 3
  function row(b: number, g: number, r: number, a = 255): number[] {
    return Array.from({ length: outW }, () => [b, g, r, a]).flat()
  }

  it('concatenates BGRA rows in order', () => {
    const top = Buffer.from([...row(1, 2, 3), ...row(4, 5, 6)])
    const bottom = Buffer.from(row(7, 8, 9))
    const out = composeBitmapTiles(
      [
        { bitmap: top, h: 2 },
        { bitmap: bottom, h: 1 },
      ],
      outW,
    )
    expect(out).toMatchObject({ width: 3, height: 3 })
    expect(out.bitmap.byteLength).toBe(3 * 3 * 4)
    expect([...out.bitmap.subarray(0, 4)]).toEqual([1, 2, 3, 255])
    expect([...out.bitmap.subarray(2 * outW * 4, 2 * outW * 4 + 4)]).toEqual([7, 8, 9, 255])
  })

  it('rejects a tile whose byte length does not match its height', () => {
    expect(() => composeBitmapTiles([{ bitmap: Buffer.alloc(5), h: 1 }], outW)).toThrow(
      /tile 0 has 5 bytes, expected 12/,
    )
  })

  it('rejects an empty tile list', () => {
    expect(() => composeBitmapTiles([], outW)).toThrow(/no tiles/)
  })
})
