import { describe, expect, it } from 'vitest'
import { overflowLabel, overflowOf } from './artboard-overflow'

describe('overflowOf', () => {
  const frame = { width: 1440, height: 900 }

  it('ignores content that fits or rounds within a pixel', () => {
    expect(overflowOf({ w: 1440, h: 900 }, frame)).toBeNull()
    expect(overflowOf({ w: 1440.6, h: 900.4 }, frame)).toBeNull()
  })

  it('reports how far the content runs past the artboard', () => {
    expect(overflowOf({ w: 1440, h: 1220 }, frame)).toEqual({ w: 0, h: 320 })
    expect(overflowOf({ w: 1500, h: 1220 }, frame)).toEqual({ w: 60, h: 320 })
  })

  it('names the overflow in the badge', () => {
    expect(overflowLabel({ w: 0, h: 320 })).toBe('Conteúdo passa 320px abaixo')
    expect(overflowLabel({ w: 60, h: 320 })).toBe('Conteúdo passa 320px abaixo e 60px à direita')
  })
})
