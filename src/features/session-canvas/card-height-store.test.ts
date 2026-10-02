import { describe, expect, it } from 'vitest'
import { nextHeights } from './card-height-store'

describe('nextHeights', () => {
  it('grava a altura arredondada e ignora ruído de subpixel', () => {
    const a = nextHeights({}, 's1', 180.4)
    expect(a).toEqual({ s1: 180 })
    expect(nextHeights(a, 's1', 181)).toBe(a)
    expect(nextHeights(a, 's1', 190)).toEqual({ s1: 190 })
  })
  it('altura zero (cartão desmontando) não apaga a medição', () => {
    const a = { s1: 180 }
    expect(nextHeights(a, 's1', 0)).toBe(a)
  })
})
