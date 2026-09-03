import { describe, expect, it } from 'vitest'
import { ARTBOARD_PRESETS } from '@shared/types/design'
import {
  formatArtboardSize,
  formatPresetSize,
  groupPresets,
  presetMatches,
} from './artboard-format'

describe('formatArtboardSize', () => {
  it('prints fixed artboards as W×H', () => {
    expect(formatArtboardSize({ width: 1440, height: 900, sizing: 'fixed' })).toBe('1440×900')
  })

  it('prints flow artboards with the measured height in parentheses', () => {
    expect(formatArtboardSize({ width: 1440, height: 2340, sizing: 'flow' })).toBe(
      '1440×fluxo (2340)',
    )
  })
})

describe('formatPresetSize', () => {
  it('omits the starting height of a flow preset', () => {
    const landing = ARTBOARD_PRESETS.find((p) => p.id === 'landing')!
    expect(formatPresetSize(landing)).toBe('1440×fluxo')
  })

  it('prints fixed presets as W×H', () => {
    const fourK = ARTBOARD_PRESETS.find((p) => p.id === '4k')!
    expect(formatPresetSize(fourK)).toBe('3840×2160')
  })
})

describe('groupPresets', () => {
  it('orders groups Desktop, Mobile, Grandes, Landing and keeps every preset', () => {
    const groups = groupPresets()
    expect(groups.map((g) => g.label)).toEqual(['Desktop', 'Mobile', 'Grandes', 'Landing'])
    expect(groups.flatMap((g) => g.presets).length).toBe(ARTBOARD_PRESETS.length)
    expect(groups[3].presets.map((p) => p.id)).toEqual(['landing', 'landing-mobile'])
  })

  it('drops empty groups', () => {
    const groups = groupPresets(ARTBOARD_PRESETS.filter((p) => p.group === 'mobile'))
    expect(groups.map((g) => g.group)).toEqual(['mobile'])
  })
})

describe('presetMatches', () => {
  const landing = ARTBOARD_PRESETS.find((p) => p.id === 'landing')!
  const desktop = ARTBOARD_PRESETS.find((p) => p.id === 'desktop')!

  it('matches a flow preset by width and sizing only', () => {
    expect(presetMatches(landing, { width: 1440, height: 5000, sizing: 'flow' })).toBe(true)
    expect(presetMatches(landing, { width: 1440, height: 900, sizing: 'fixed' })).toBe(false)
  })

  it('matches a fixed preset by full size', () => {
    expect(presetMatches(desktop, { width: 1440, height: 900, sizing: 'fixed' })).toBe(true)
    expect(presetMatches(desktop, { width: 1440, height: 901, sizing: 'fixed' })).toBe(false)
  })
})
