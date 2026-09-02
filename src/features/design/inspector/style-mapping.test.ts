import { describe, expect, it } from 'vitest'
import {
  normalizePatch,
  parsePx,
  readAutoLayout,
  readBlend,
  readBorder,
  readOpacity,
  readPadding,
  readPosition,
  readRadius,
  readShadow,
  readSizing,
  readTypography,
  writeAutoLayout,
  writeBlend,
  writeBorder,
  writeOpacity,
  writePosition,
  writeRadius,
  writeShadow,
  writeSizing,
  writeTypography,
} from './style-mapping'

describe('parsePx / normalizePatch', () => {
  it('parses px and unitless numbers, rejects other units', () => {
    expect(parsePx('12px')).toBe(12)
    expect(parsePx('1.5')).toBe(1.5)
    expect(parsePx('-4px')).toBe(-4)
    expect(parsePx('50%')).toBeNull()
    expect(parsePx(undefined)).toBeNull()
  })

  it('clears the camelCase twin when writing kebab keys', () => {
    expect(normalizePatch({ borderRadius: '4px' }, { 'border-radius': '8px' })).toEqual({
      'border-radius': '8px',
      borderRadius: null,
    })
    expect(normalizePatch({}, { gap: '4px' })).toEqual({ gap: '4px' })
  })
})

describe('sizing', () => {
  it('reads hug/fill/fixed from either spelling', () => {
    expect(readSizing({}, 'width')).toEqual({ mode: 'hug', px: null })
    expect(readSizing({ width: '120px' }, 'width')).toEqual({ mode: 'fixed', px: 120 })
    expect(readSizing({ width: '100%' }, 'width')).toEqual({ mode: 'fill', px: null })
    expect(readSizing({ flex: '1 1 0' }, 'width')).toEqual({ mode: 'fill', px: null })
    expect(readSizing({ minHeight: '0', height: '40px' }, 'height')).toEqual({ mode: 'fixed', px: 40 })
  })

  it('writes fill differently inside and outside flex', () => {
    expect(writeSizing('width', { mode: 'fill', px: null }, true)).toEqual({
      width: null,
      flex: '1 1 0',
      'min-width': '0',
    })
    expect(writeSizing('width', { mode: 'fill', px: null }, false)).toEqual({
      width: '100%',
      flex: null,
      'min-width': null,
    })
    expect(writeSizing('height', { mode: 'hug', px: null }, true)).toEqual({
      height: 'auto',
      flex: 'none',
      'min-height': null,
    })
    expect(writeSizing('width', { mode: 'fixed', px: 200 }, true)).toEqual({
      width: '200px',
      flex: 'none',
      'min-width': null,
    })
  })
})

describe('auto layout', () => {
  it('reads flex properties with defaults', () => {
    expect(readAutoLayout({})).toEqual({
      enabled: false,
      direction: 'row',
      gap: 0,
      padding: [0, 0, 0, 0],
      align: 'stretch',
      justify: 'flex-start',
      wrap: false,
    })
    expect(
      readAutoLayout({
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '4px 8px',
        'padding-left': '2px',
        'align-items': 'center',
        'justify-content': 'space-between',
        'flex-wrap': 'wrap',
      }),
    ).toEqual({
      enabled: true,
      direction: 'column',
      gap: 8,
      padding: [4, 8, 4, 2],
      align: 'center',
      justify: 'space-between',
      wrap: true,
    })
  })

  it('collapses padding shorthand and clears longhands', () => {
    expect(readPadding({ padding: '4px' })).toEqual([4, 4, 4, 4])
    const patch = writeAutoLayout({
      enabled: true,
      direction: 'row',
      gap: 12,
      padding: [8, 16, 8, 16],
      align: 'stretch',
      justify: 'center',
      wrap: false,
    })
    expect(patch).toMatchObject({
      display: 'flex',
      'flex-direction': 'row',
      gap: '12px',
      padding: '8px 16px',
      'align-items': null,
      'justify-content': 'center',
      'flex-wrap': null,
      'padding-left': null,
    })
  })

  it('disabling removes every flex key', () => {
    const patch = writeAutoLayout({ ...readAutoLayout({}), enabled: false })
    expect(Object.values(patch).every((v) => v === null)).toBe(true)
    expect(patch).toHaveProperty('display', null)
  })
})

describe('radius / border / shadow', () => {
  it('reads and writes per-corner radius', () => {
    expect(readRadius({ 'border-radius': '4px 8px' })).toEqual([4, 8, 4, 8])
    expect(readRadius({ borderRadius: '4px', 'border-top-left-radius': '0px' })).toEqual([0, 4, 4, 4])
    expect(writeRadius([8, 8, 8, 8])['border-radius']).toBe('8px')
    expect(writeRadius([1, 2, 3, 4])['border-radius']).toBe('1px 2px 3px 4px')
    expect(writeRadius([0, 0, 0, 0])).toMatchObject({
      'border-radius': null,
      'border-top-left-radius': null,
    })
  })

  it('parses the border shorthand in any order', () => {
    expect(readBorder({ border: '1px solid #ff0000' })).toEqual({ width: 1, style: 'solid', color: '#ff0000' })
    expect(readBorder({ border: 'dashed var(--color-primary) 2px' })).toEqual({
      width: 2,
      style: 'dashed',
      color: 'var(--color-primary)',
    })
    expect(readBorder({})).toEqual({ width: 0, style: 'solid', color: '' })
    expect(writeBorder({ width: 0, style: 'solid', color: '#000' }).border).toBeNull()
    expect(writeBorder({ width: 2, style: 'dotted', color: '#000' }).border).toBe('2px dotted #000')
  })

  it('matches shadow presets and flags custom values', () => {
    expect(readShadow({})).toBe('none')
    expect(readShadow({ boxShadow: '0 4px 12px rgba(0,0,0,0.12)' })).toBe('md')
    expect(readShadow({ 'box-shadow': '0 0 0 1px red' })).toBe('custom')
    expect(writeShadow('none')).toEqual({ 'box-shadow': null })
    expect(writeShadow('sm')['box-shadow']).toContain('1px')
  })
})

describe('position / opacity / blend', () => {
  it('maps position and offsets', () => {
    expect(readPosition({ position: 'absolute', top: '10px', left: '20px' })).toEqual({
      mode: 'absolute',
      top: 10,
      left: 20,
    })
    expect(readPosition({ position: 'sticky' }).mode).toBe('static')
    expect(writePosition({ mode: 'static', top: 5, left: 5 })).toEqual({ position: null, top: null, left: null })
    expect(writePosition({ mode: 'absolute', top: 1, left: null })).toEqual({
      position: 'absolute',
      top: '1px',
      left: null,
    })
  })

  it('maps opacity percent and blend mode', () => {
    expect(readOpacity({})).toBe(100)
    expect(readOpacity({ opacity: '0.5' })).toBe(50)
    expect(writeOpacity(100)).toEqual({ opacity: null })
    expect(writeOpacity(25)).toEqual({ opacity: '0.25' })
    expect(writeOpacity(140)).toEqual({ opacity: null })
    expect(readBlend({ mixBlendMode: 'multiply' })).toBe('multiply')
    expect(writeBlend('normal')).toEqual({ 'mix-blend-mode': null })
  })
})

describe('typography', () => {
  it('reads with fallbacks and writes only the given keys', () => {
    expect(readTypography({ 'font-size': '14px', fontWeight: '600', color: '#111' })).toMatchObject({
      fontSize: 14,
      fontWeight: '600',
      color: '#111',
      textAlign: 'left',
      fontFamily: '',
    })
    expect(writeTypography({ fontSize: 18, textAlign: 'center' })).toEqual({
      'font-size': '18px',
      'text-align': 'center',
    })
    expect(writeTypography({ fontWeight: '400', textAlign: 'left', color: '' })).toEqual({
      'font-weight': null,
      'text-align': null,
      color: null,
    })
  })
})
