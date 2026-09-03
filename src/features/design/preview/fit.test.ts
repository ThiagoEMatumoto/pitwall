import { describe, expect, it } from 'vitest'
import { fitScale, fitsByWidth } from './fit'

describe('fitScale', () => {
  it('never upscales and respects padding', () => {
    expect(fitScale({ w: 390, h: 844 }, { w: 1920, h: 1080 }, 'fit')).toBe(1)
    expect(fitScale({ w: 1440, h: 900 }, { w: 720, h: 900 }, 'fit')).toBe(0.5)
    expect(fitScale({ w: 1000, h: 1000 }, { w: 600, h: 1000 }, 'fit', 50)).toBe(0.5)
  })

  it('actual is always 1', () => {
    expect(fitScale({ w: 1440, h: 900 }, { w: 100, h: 100 }, 'actual')).toBe(1)
  })

  it('flow artboards fit by width regardless of height', () => {
    expect(fitScale({ w: 1440, h: 6000 }, { w: 720, h: 900 }, 'fit', 0, 'flow')).toBe(0.5)
    expect(fitScale({ w: 390, h: 6000 }, { w: 1920, h: 900 }, 'fit', 0, 'flow')).toBe(1)
  })

  it('a fixed landing much taller than the stage fits by width; a phone fits whole', () => {
    expect(fitScale({ w: 1440, h: 4000 }, { w: 1440, h: 1000 }, 'fit')).toBe(1)
    expect(fitScale({ w: 390, h: 844 }, { w: 1000, h: 600 }, 'fit')).toBeCloseTo(600 / 844)
  })

  it('degenerate sizes fall back to 1', () => {
    expect(fitScale({ w: 0, h: 900 }, { w: 720, h: 900 }, 'fit')).toBe(1)
    expect(fitScale({ w: 1440, h: 900 }, { w: 10, h: 10 }, 'fit', 20)).toBe(1)
  })
})

describe('fitsByWidth', () => {
  it('uses the tall ratio between the width-fit and height-fit scales', () => {
    expect(fitsByWidth({ w: 1000, h: 2000 }, { w: 1000, h: 1000 }, 'fixed')).toBe(true)
    expect(fitsByWidth({ w: 1000, h: 1999 }, { w: 1000, h: 1000 }, 'fixed')).toBe(false)
    expect(fitsByWidth({ w: 1000, h: 100 }, { w: 1000, h: 1000 }, 'flow')).toBe(true)
  })
})
