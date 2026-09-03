import { describe, expect, it } from 'vitest'
import { centerViewport, fitViewport, visibleArtboardIds } from './geometry'

const stage = { w: 1000, h: 800 }

describe('fitViewport', () => {
  it('never zooms an artboard past 100%', () => {
    const vp = fitViewport({ x: 0, y: 0, w: 100, h: 100 }, stage)
    expect(vp.zoom).toBe(1)
    expect(vp).toEqual({ x: 450, y: 350, zoom: 1 })
  })

  it('lets a selection zoom in up to maxZoom', () => {
    expect(fitViewport({ x: 0, y: 0, w: 100, h: 100 }, stage, 64, 4).zoom).toBe(4)
    expect(fitViewport({ x: 0, y: 0, w: 400, h: 100 }, stage, 64, 4).zoom).toBe(2.18)
  })
})

describe('centerViewport', () => {
  it('puts the bounds in the middle of the stage at the given zoom', () => {
    const vp = centerViewport({ x: 200, y: 100, w: 100, h: 50 }, stage, 1)
    expect(vp).toEqual({ x: 250, y: 275, zoom: 1 })
  })
})

describe('visibleArtboardIds', () => {
  const metas = [
    { id: 'a', x: 0, y: 0, width: 1440, height: 900 },
    { id: 'b', x: 1600, y: 0, width: 390, height: 844 },
    { id: 'c', x: 0, y: 20_000, width: 1440, height: 9000 },
  ]

  it('keeps the frames that meet the stage grown by the margin', () => {
    const vp = { x: 0, y: 0, zoom: 1 }
    expect(visibleArtboardIds(metas, vp, stage, 0)).toEqual(['a'])
    expect(visibleArtboardIds(metas, vp, stage, 1)).toEqual(['a', 'b'])
    expect(visibleArtboardIds(metas, { x: 0, y: -19_500, zoom: 1 }, stage, 0)).toEqual(['c'])
  })

  it('works in screen space: zoomed out, everything fits', () => {
    expect(visibleArtboardIds(metas, { x: 0, y: 0, zoom: 0.02 }, stage, 0)).toEqual(['a', 'b', 'c'])
  })
})
