import { describe, expect, it } from 'vitest'
import { computedColor, computedPx, computedText } from './computed-format'

describe('computedColor', () => {
  it('turns rgb()/rgba() into hex and fully transparent into "transparent"', () => {
    expect(computedColor('rgb(255, 0, 128)')).toBe('#ff0080')
    expect(computedColor('rgba(0, 0, 0, 0)')).toBe('transparent')
    expect(computedColor('rgba(0, 0, 0, 0.5)')).toBe('#00000080')
    expect(computedColor('rgba(17, 34, 51, 1)')).toBe('#112233')
  })

  it('passes other formats through and tolerates missing values', () => {
    expect(computedColor('color(srgb 1 0 0)')).toBe('color(srgb 1 0 0)')
    expect(computedColor(undefined)).toBe('')
  })
})

describe('computedPx / computedText', () => {
  it('reads the number out of a px value and falls back otherwise', () => {
    expect(computedPx('16px')).toBe('16')
    expect(computedPx('0.5px')).toBe('0.5')
    expect(computedPx('normal', '0')).toBe('0')
    expect(computedPx(undefined, '16')).toBe('16')
  })

  it('shows a dash for empty text', () => {
    expect(computedText('Inter, sans-serif')).toBe('Inter, sans-serif')
    expect(computedText('')).toBe('—')
    expect(computedText(undefined, '1.5')).toBe('1.5')
  })
})
