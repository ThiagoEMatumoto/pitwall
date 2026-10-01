import { describe, expect, it } from 'vitest'
import { clampMenuPosition } from './menu-position'

const viewport = { width: 1400, height: 900 }
const size = { width: 200, height: 260 }

describe('clampMenuPosition', () => {
  it('keeps the click point when the menu fits', () => {
    expect(clampMenuPosition({ x: 100, y: 100 }, size, viewport)).toEqual({ x: 100, y: 100 })
  })

  it('opens upwards when a click near the bottom would clip the menu', () => {
    expect(clampMenuPosition({ x: 100, y: 850 }, size, viewport)).toEqual({ x: 100, y: 590 })
  })

  it('opens to the left when a click near the right edge would clip the menu', () => {
    expect(clampMenuPosition({ x: 1350, y: 100 }, size, viewport)).toEqual({ x: 1150, y: 100 })
  })

  it('never goes past the top-left margin when the menu is taller than the room', () => {
    expect(clampMenuPosition({ x: 5, y: 200 }, { width: 200, height: 1000 }, viewport)).toEqual({
      x: 5,
      y: 8,
    })
  })
})
