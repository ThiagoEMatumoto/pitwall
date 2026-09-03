import { describe, expect, it } from 'vitest'
import type { DesignMotion, DesignNode } from '@shared/types/design'
import {
  ENTRANCE_UI_DEFAULTS,
  HOVER_UI_DEFAULTS,
  LOOP_UI_DEFAULTS,
  PARALLAX_UI_DEFAULTS,
  hasMotion,
  hasUserTransform,
  readMotionUi,
  usesDistance,
  writeMotionSection,
} from './motion-mapping'

const stored: DesignMotion = {
  entrance: {
    preset: 'slide-up',
    trigger: 'in-view',
    duration: 240,
    delay: 40,
    easing: 'spring-quick',
    distance: 32,
    stagger: 60,
  },
  hover: { preset: 'lift', duration: 160, easing: 'ease-out' },
}

describe('readMotionUi', () => {
  it('returns every section off for a node without motion', () => {
    expect(readMotionUi(undefined)).toEqual({
      entrance: null,
      hover: null,
      loop: null,
      parallax: null,
    })
  })

  it('mirrors stored values and fills the optional ones with defaults', () => {
    const ui = readMotionUi(stored)
    expect(ui.entrance).toEqual({
      preset: 'slide-up',
      trigger: 'in-view',
      duration: 240,
      delay: 40,
      easing: 'spring-quick',
      distance: 32,
      stagger: 60,
    })
    expect(ui.hover).toEqual({
      preset: 'lift',
      duration: 160,
      easing: 'ease-out',
      intensity: 1,
    })
    expect(ui.loop).toBeNull()
  })

  it('fills distance, stagger and direction when the tree omits them', () => {
    const ui = readMotionUi({
      entrance: {
        preset: 'fade',
        trigger: 'load',
        duration: 220,
        delay: 0,
        easing: 'ease-out',
      },
      loop: { preset: 'spin', duration: 4000 },
    })
    expect(ui.entrance?.distance).toBe(ENTRANCE_UI_DEFAULTS.distance)
    expect(ui.entrance?.stagger).toBe(0)
    expect(ui.loop?.direction).toBe(LOOP_UI_DEFAULTS.direction)
  })
})

describe('writeMotionSection', () => {
  it('turns a section on with the UI defaults and keeps the others', () => {
    const next = writeMotionSection(stored, 'loop', LOOP_UI_DEFAULTS)
    expect(next?.entrance).toEqual(stored.entrance)
    expect(next?.hover).toEqual(stored.hover)
    expect(next?.loop).toEqual({ preset: 'pulse', duration: 1800 })
  })

  it('keeps default-valued optionals out of the tree', () => {
    const next = writeMotionSection(undefined, 'loop', {
      ...LOOP_UI_DEFAULTS,
      preset: 'spin',
    })
    expect(next?.loop).toEqual({ preset: 'spin', duration: 1800 })
    const slide = writeMotionSection(undefined, 'entrance', {
      ...ENTRANCE_UI_DEFAULTS,
      preset: 'slide-up',
    })
    expect(slide?.entrance?.distance).toBeUndefined()
    const far = writeMotionSection(undefined, 'entrance', {
      ...ENTRANCE_UI_DEFAULTS,
      preset: 'slide-up',
      distance: 48,
    })
    expect(far?.entrance?.distance).toBe(48)
  })

  it('turns a section off and returns null once nothing is left', () => {
    const noHover = writeMotionSection(stored, 'hover', null)
    expect(noHover?.hover).toBeUndefined()
    expect(noHover?.entrance).toEqual(stored.entrance)
    expect(writeMotionSection(noHover ?? undefined, 'entrance', null)).toBeNull()
  })

  it('drops distance for non-slide presets and a zero stagger', () => {
    const next = writeMotionSection(undefined, 'entrance', {
      ...ENTRANCE_UI_DEFAULTS,
      preset: 'fade',
      distance: 80,
      stagger: 0,
    })
    expect(next?.entrance).toEqual({
      preset: 'fade',
      trigger: 'load',
      duration: 220,
      delay: 0,
      easing: 'ease-out',
    })
    expect(usesDistance('fade')).toBe(false)
    expect(usesDistance('slide-left')).toBe(true)
  })

  it('clamps out-of-range numbers instead of storing them', () => {
    const next = writeMotionSection(undefined, 'hover', {
      ...HOVER_UI_DEFAULTS,
      intensity: 9,
    })
    expect(next?.hover?.intensity).toBe(3)
    const par = writeMotionSection(undefined, 'parallax', { factor: -4 })
    expect(par?.parallax?.factor).toBe(-1)
  })

  it('round-trips a full entrance through read and write', () => {
    const ui = readMotionUi(stored)
    const next = writeMotionSection(stored, 'entrance', ui.entrance)
    expect(next?.entrance).toEqual(stored.entrance)
  })

  it('enables parallax at a visible factor', () => {
    const next = writeMotionSection(undefined, 'parallax', PARALLAX_UI_DEFAULTS)
    expect(next?.parallax?.factor).toBeGreaterThan(0)
  })
})

describe('node guards', () => {
  const base = (over: Partial<DesignNode>): Pick<DesignNode, 'motion' | 'style'> => ({
    style: {},
    ...over,
  })

  it('hasMotion ignores an empty motion object', () => {
    expect(hasMotion(base({}))).toBe(false)
    expect(hasMotion(base({ motion: {} }))).toBe(false)
    expect(hasMotion(base({ motion: stored }))).toBe(true)
  })

  it('hasUserTransform reads both kebab and camel keys and ignores none', () => {
    expect(hasUserTransform(base({ style: { transform: 'rotate(3deg)' } }))).toBe(true)
    expect(hasUserTransform(base({ style: { transform: 'none' } }))).toBe(false)
    expect(hasUserTransform(base({ style: {} }))).toBe(false)
  })
})
