import { describe, expect, it } from 'vitest'
import type { DesignMotion, DesignNode } from '../types/design'
import {
  EASING_CSS,
  MOTION_DEFAULTS,
  MOTION_RANGES,
  childMotionContext,
  isMotion,
  motionAttrs,
  motionSummary,
  normalizeMotion,
  springLinear,
  treeHasMotion,
  viewTransitionName,
} from './motion'

const full: DesignMotion = {
  entrance: { preset: 'slide-up', trigger: 'in-view', duration: 240, delay: 40, easing: 'back' },
  hover: { preset: 'lift', duration: 160, easing: 'ease-out', intensity: 1.5 },
  loop: { preset: 'marquee', duration: 8000, direction: 'reverse' },
  parallax: { factor: -0.3 },
}

const node = (partial: Partial<DesignNode> & { id: string }): DesignNode => ({
  tag: 'div',
  kind: 'frame',
  style: {},
  attrs: {},
  children: [],
  ...partial,
})

describe('isMotion', () => {
  it('accepts a full motion, an empty object and a single section', () => {
    expect(isMotion(full)).toBe(true)
    expect(isMotion({})).toBe(true)
    expect(isMotion({ parallax: { factor: 1 } })).toBe(true)
  })

  it('rejects unknown keys at every level', () => {
    expect(isMotion({ entrance: { ...full.entrance, durration: 1 } })).toBe(false)
    expect(isMotion({ ...full, bounce: true })).toBe(false)
    expect(isMotion({ hover: { ...full.hover, color: 'red' } })).toBe(false)
    expect(isMotion({ parallax: { factor: 0.5, axis: 'x' } })).toBe(false)
  })

  it('rejects values outside the ranges and unknown presets', () => {
    expect(isMotion({ entrance: { ...full.entrance, duration: 5001 } })).toBe(false)
    expect(isMotion({ entrance: { ...full.entrance, delay: -1 } })).toBe(false)
    expect(isMotion({ entrance: { ...full.entrance, distance: 401 } })).toBe(false)
    expect(isMotion({ entrance: { ...full.entrance, stagger: 1001 } })).toBe(false)
    expect(isMotion({ entrance: { ...full.entrance, preset: 'wiggle' } })).toBe(false)
    expect(isMotion({ entrance: { ...full.entrance, easing: 'ease' } })).toBe(false)
    expect(isMotion({ hover: { ...full.hover, intensity: 0 } })).toBe(false)
    expect(isMotion({ loop: { ...full.loop, duration: 50 } })).toBe(false)
    expect(isMotion({ loop: { ...full.loop, direction: 'backwards' } })).toBe(false)
    expect(isMotion({ parallax: { factor: 1.2 } })).toBe(false)
    expect(isMotion({ parallax: { factor: NaN } })).toBe(false)
  })

  it('rejects non-objects, arrays and missing required fields', () => {
    expect(isMotion(null)).toBe(false)
    expect(isMotion([])).toBe(false)
    expect(isMotion('fade')).toBe(false)
    expect(isMotion({ entrance: { preset: 'fade' } })).toBe(false)
    expect(isMotion({ entrance: null })).toBe(false)
  })
})

describe('normalizeMotion', () => {
  it('fills defaults, clamps into range and rounds', () => {
    const out = normalizeMotion({
      entrance: { preset: 'fade', duration: 9000, delay: -5, distance: 12.6, stagger: 2000 },
      hover: { preset: 'glow', intensity: 9 },
      loop: { preset: 'spin', duration: 10 },
      parallax: { factor: 0.12345 },
    })
    expect(out).toEqual({
      entrance: {
        preset: 'fade',
        trigger: 'load',
        duration: MOTION_RANGES.duration[1],
        delay: 0,
        easing: MOTION_DEFAULTS.easing,
        distance: 13,
        stagger: MOTION_RANGES.stagger[1],
      },
      hover: {
        preset: 'glow',
        duration: MOTION_DEFAULTS.hoverDuration,
        easing: 'ease-out',
        intensity: 3,
      },
      loop: { preset: 'spin', duration: MOTION_RANGES.loopDuration[0] },
      parallax: { factor: 0.12 },
    })
    expect(isMotion(out)).toBe(true)
  })

  it('is idempotent on an already normalised motion and keeps stagger 0 out', () => {
    expect(normalizeMotion(full)).toEqual(full)
    expect(
      normalizeMotion({ entrance: { preset: 'fade', stagger: 0 } })!.entrance,
    ).not.toHaveProperty('stagger')
  })

  it('returns null for nothing enabled and throws on an unknown preset/easing', () => {
    expect(normalizeMotion(null)).toBeNull()
    expect(normalizeMotion({})).toBeNull()
    expect(normalizeMotion({ entrance: null, hover: null })).toBeNull()
    expect(() => normalizeMotion({ entrance: { preset: 'wiggle' } })).toThrow(/entrance preset/)
    expect(() => normalizeMotion({ hover: { preset: 'lift', easing: 'ease' } })).toThrow(/easing/)
    expect(() => normalizeMotion({ loop: { preset: 'spin', direction: 'up' } })).toThrow(
      /direction/,
    )
  })
})

describe('EASING_CSS', () => {
  it('maps every easing; springs are linear() curves ending at 1', () => {
    expect(EASING_CSS['ease-out']).toMatch(/^cubic-bezier\(/)
    expect(EASING_CSS.back).toBe('cubic-bezier(0.34, 1.56, 0.64, 1)')
    for (const key of ['spring-gentle', 'spring-quick', 'spring-bouncy'] as const) {
      expect(EASING_CSS[key]).toMatch(/^linear\(0, .* 1\)$/)
    }
    // Bouncy overshoots past 1; gentle stays close to it.
    const max = (css: string) => Math.max(...css.match(/[\d.]+(?= \d+%)/g)!.map(Number))
    expect(max(EASING_CSS['spring-bouncy'])).toBeGreaterThan(1.05)
    expect(max(EASING_CSS['spring-gentle'])).toBeLessThan(1.05)
    expect(springLinear(0.5, 10, 4)).toMatch(/^linear\(0, [\d.]+ 25%, [\d.]+ 50%, [\d.]+ 75%, 1\)$/)
  })
})

describe('motionAttrs', () => {
  it('projects each section to attributes and variables', () => {
    const { attrs, vars } = motionAttrs(node({ id: 'a', motion: full }))
    expect(attrs).toEqual({
      'data-pw-m-in': 'slide-up',
      'data-pw-m-trigger': 'in-view',
      'data-pw-m-hover': 'lift',
      'data-pw-m-loop': 'marquee',
      'data-pw-m-par': '-0.3',
    })
    expect(vars).toEqual({
      '--pw-dur': '240ms',
      '--pw-delay': '40ms',
      '--pw-ease': EASING_CSS.back,
      '--pw-dist': '24px',
      '--pw-hdur': '160ms',
      '--pw-hease': EASING_CSS['ease-out'],
      '--pw-int': '1.5',
      '--pw-loop-dur': '8000ms',
      '--pw-loop-dir': 'reverse',
      '--pw-par': '-0.3',
    })
  })

  it('a staggered entrance moves to the children with their index', () => {
    const list = node({
      id: 'list',
      motion: { entrance: { ...full.entrance!, stagger: 60 } },
      children: [node({ id: 'c0' }), node({ id: 'c1' })],
    })
    expect(motionAttrs(list)).toEqual({ attrs: { 'data-pw-m-stagger': '60' }, vars: {} })
    const ctx = childMotionContext(list, 1)
    const child = motionAttrs(list.children[1], ctx)
    expect(child.attrs).toEqual({ 'data-pw-m-in': 'slide-up', 'data-pw-m-trigger': 'in-view' })
    expect(child.vars['--pw-i']).toBe('1')
    expect(child.vars['--pw-stagger']).toBe('60ms')
    expect(child.vars['--pw-dur']).toBe('240ms')
    // A child with its own entrance keeps it.
    const own = node({ id: 'c1', motion: { entrance: { ...full.entrance!, preset: 'blur' } } })
    expect(motionAttrs(own, ctx).attrs['data-pw-m-in']).toBe('blur')
    expect(motionAttrs(own, ctx).vars).not.toHaveProperty('--pw-i')
    expect(childMotionContext(node({ id: 'x', motion: full }), 0)).toEqual({})
  })

  it('no motion = nothing', () => {
    expect(motionAttrs(node({ id: 'a' }))).toEqual({ attrs: {}, vars: {} })
    expect(motionAttrs(node({ id: 'a', motion: {} }))).toEqual({ attrs: {}, vars: {} })
  })
})

describe('treeHasMotion / motionSummary / viewTransitionName', () => {
  it('finds motion anywhere in the tree, ignoring empty objects', () => {
    expect(treeHasMotion(node({ id: 'r' }))).toBe(false)
    expect(treeHasMotion(node({ id: 'r', motion: {} }))).toBe(false)
    expect(
      treeHasMotion(
        node({ id: 'r', children: [node({ id: 'c', motion: { parallax: { factor: 0.2 } } })] }),
      ),
    ).toBe(true)
  })

  it('summarises in one line', () => {
    expect(motionSummary(full)).toBe(
      'in: slide-up 240ms in-view +40 · hover: lift · loop: marquee 8000ms · parallax: -0.3',
    )
    expect(
      motionSummary({ entrance: { ...full.entrance!, trigger: 'load', delay: 0, stagger: 60 } }),
    ).toBe('in: slide-up 240ms +stagger 60')
    expect(motionSummary({})).toBe('')
  })

  it('slugs names for view-transition-name', () => {
    expect(viewTransitionName('Hero Title')).toBe('pw-hero-title')
    expect(viewTransitionName('  Cardápio / 2 ')).toBe('pw-card-pio-2')
    expect(viewTransitionName('---')).toBeNull()
  })
})
