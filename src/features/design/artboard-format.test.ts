import { describe, expect, it } from 'vitest'
import { ARTBOARD_MAX_PX, ARTBOARD_MIN_PX } from '@shared/design/safety'
import { ARTBOARD_PRESETS, customPreset } from '@shared/types/design'
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
  it('orders the groups and keeps every preset', () => {
    const groups = groupPresets()
    expect(groups.map((g) => g.label)).toEqual([
      'Desktop',
      'Mobile',
      'Grandes',
      'Landing',
      'Documento',
      'Apresentação',
    ])
    expect(groups.flatMap((g) => g.presets).length).toBe(ARTBOARD_PRESETS.length)
    expect(groups[3].presets.map((p) => p.id)).toEqual(['landing', 'landing-mobile'])
  })

  it('never lists a typed size', () => {
    const groups = groupPresets([...ARTBOARD_PRESETS, customPreset(300, 300)])
    expect(groups.flatMap((g) => g.presets).map((p) => p.id)).not.toContain('custom')
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

describe('customPreset', () => {
  it('keeps a size inside the limits as typed', () => {
    const preset = customPreset(794, 1123)
    expect(preset).toMatchObject({ width: 794, height: 1123, sizing: 'fixed' })
  })

  it('clamps both axes to the artboard limits', () => {
    expect(customPreset(0, 999_999)).toMatchObject({
      width: ARTBOARD_MIN_PX,
      height: ARTBOARD_MAX_PX,
    })
  })

  it('rounds a fractional size instead of refusing it', () => {
    expect(customPreset(793.7, 1122.5)).toMatchObject({ width: 794, height: 1123 })
  })
})

describe('document presets', () => {
  it('carries A4 and Letter at 96 DPI, both orientations', () => {
    const byId = Object.fromEntries(ARTBOARD_PRESETS.map((p) => [p.id, p]))
    expect(byId['a4']).toMatchObject({ width: 794, height: 1123 })
    expect(byId['a4-landscape']).toMatchObject({ width: 1123, height: 794 })
    expect(byId['letter']).toMatchObject({ width: 816, height: 1056 })
    expect(byId['letter-landscape']).toMatchObject({ width: 1056, height: 816 })
    expect(byId['slide-16-9']).toMatchObject({ width: 1920, height: 1080 })
  })
})
