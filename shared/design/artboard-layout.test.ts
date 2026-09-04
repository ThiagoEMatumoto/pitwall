import { describe, expect, it } from 'vitest'
import { ARTBOARD_GAP } from './safety'
import { duplicateArtboardX, nextArtboardX } from './artboard-layout'

describe('nextArtboardX', () => {
  it('starts the first artboard at the origin', () => {
    expect(nextArtboardX([])).toBe(0)
  })

  it('lands after the rightmost artboard, not the last one added', () => {
    const existing = [
      { x: 0, width: 1440 },
      { x: 4000, width: 390 },
      { x: 1560, width: 834 },
    ]
    expect(nextArtboardX(existing)).toBe(4390 + ARTBOARD_GAP)
  })
})

describe('duplicateArtboardX', () => {
  it('puts the copy one gap to the right of its original', () => {
    expect(duplicateArtboardX({ x: 200, width: 794 })).toBe(994 + ARTBOARD_GAP)
  })

  it('does not care about other artboards already there', () => {
    expect(duplicateArtboardX({ x: -500, width: 100 })).toBe(-400 + ARTBOARD_GAP)
  })
})
