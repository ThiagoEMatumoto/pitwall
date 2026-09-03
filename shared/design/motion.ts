// Motion model: presets per node, validated and normalised here, projected to
// data-pw-m-* attributes + --pw-* variables by html-render.ts and animated by
// the static sheet in motion-css.ts. Pure TS: runs in main, renderer and the
// iframe runtime. Nothing here imports safety.ts (safety imports this).

import { EASING_CSS } from './motion-easing'
import type {
  DesignEasing,
  DesignMotion,
  DesignMotionEntrance,
  DesignMotionHover,
  DesignMotionLoop,
  DesignMotionParallax,
  DesignNode,
  EntrancePreset,
  EntranceTrigger,
  HoverPreset,
  LoopDirection,
  LoopPreset,
} from '../types/design'

// ---- enums (arrays for zod/UI, sets for guards) ----

export const ENTRANCE_PRESETS = [
  'fade',
  'slide-up',
  'slide-down',
  'slide-left',
  'slide-right',
  'scale',
  'blur',
] as const satisfies readonly EntrancePreset[]
export const ENTRANCE_TRIGGERS = ['load', 'in-view'] as const satisfies readonly EntranceTrigger[]
export const HOVER_PRESETS = [
  'lift',
  'scale',
  'glow',
  'color',
] as const satisfies readonly HoverPreset[]
export const LOOP_PRESETS = [
  'pulse',
  'marquee',
  'float',
  'spin',
] as const satisfies readonly LoopPreset[]
export const LOOP_DIRECTIONS = [
  'normal',
  'reverse',
  'alternate',
] as const satisfies readonly LoopDirection[]
export const EASINGS = [
  'ease-out',
  'ease-in-out',
  'linear',
  'back',
  'spring-gentle',
  'spring-quick',
  'spring-bouncy',
] as const satisfies readonly DesignEasing[]

const ENTRANCE_SET: ReadonlySet<string> = new Set(ENTRANCE_PRESETS)
const TRIGGER_SET: ReadonlySet<string> = new Set(ENTRANCE_TRIGGERS)
const HOVER_SET: ReadonlySet<string> = new Set(HOVER_PRESETS)
const LOOP_SET: ReadonlySet<string> = new Set(LOOP_PRESETS)
const DIRECTION_SET: ReadonlySet<string> = new Set(LOOP_DIRECTIONS)
const EASING_SET: ReadonlySet<string> = new Set(EASINGS)

export function isEasing(value: unknown): value is DesignEasing {
  return typeof value === 'string' && EASING_SET.has(value)
}

// ---- defaults and ranges ----

export const MOTION_DEFAULTS = {
  duration: 220,
  delay: 0,
  easing: 'ease-out' as DesignEasing,
  distance: 24,
  hoverDuration: 160,
  loopDuration: 1800,
  intensity: 1,
  loopDirection: 'normal' as LoopDirection,
} as const

// [min, max]; ms for times, px for distance. Loops get their own ceiling: a
// slow marquee or an 8s spin are ordinary, a 20s entrance is not.
export const MOTION_RANGES = {
  duration: [0, 5000],
  delay: [0, 5000],
  distance: [0, 400],
  stagger: [0, 1000],
  loopDuration: [100, 20000],
  intensity: [0.1, 3],
  factor: [-1, 1],
} as const satisfies Record<string, readonly [number, number]>

type RangeKey = keyof typeof MOTION_RANGES

function inRange(value: unknown, key: RangeKey): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  const [min, max] = MOTION_RANGES[key]
  return value >= min && value <= max
}

function clampTo(value: number, key: RangeKey, decimals: number): number {
  const [min, max] = MOTION_RANGES[key]
  const n = Number.isFinite(value) ? value : min
  const factor = 10 ** decimals
  return Math.round(Math.min(max, Math.max(min, n)) * factor) / factor
}

// ---- guards (strict: what is stored must already be normalised) ----

const MOTION_KEYS: ReadonlySet<string> = new Set(['entrance', 'hover', 'loop', 'parallax'])
const ENTRANCE_KEYS: ReadonlySet<string> = new Set([
  'preset',
  'trigger',
  'duration',
  'delay',
  'easing',
  'distance',
  'stagger',
])
const HOVER_KEYS: ReadonlySet<string> = new Set(['preset', 'duration', 'easing', 'intensity'])
const LOOP_KEYS: ReadonlySet<string> = new Set(['preset', 'duration', 'direction'])
const PARALLAX_KEYS: ReadonlySet<string> = new Set(['factor'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isEntrance(value: unknown): value is DesignMotionEntrance {
  if (!isPlainObject(value) || !onlyKeys(value, ENTRANCE_KEYS)) return false
  return (
    typeof value.preset === 'string' &&
    ENTRANCE_SET.has(value.preset) &&
    typeof value.trigger === 'string' &&
    TRIGGER_SET.has(value.trigger) &&
    inRange(value.duration, 'duration') &&
    inRange(value.delay, 'delay') &&
    isEasing(value.easing) &&
    (value.distance === undefined || inRange(value.distance, 'distance')) &&
    (value.stagger === undefined || inRange(value.stagger, 'stagger'))
  )
}

function isHover(value: unknown): value is DesignMotionHover {
  if (!isPlainObject(value) || !onlyKeys(value, HOVER_KEYS)) return false
  return (
    typeof value.preset === 'string' &&
    HOVER_SET.has(value.preset) &&
    inRange(value.duration, 'duration') &&
    isEasing(value.easing) &&
    (value.intensity === undefined || inRange(value.intensity, 'intensity'))
  )
}

function isLoop(value: unknown): value is DesignMotionLoop {
  if (!isPlainObject(value) || !onlyKeys(value, LOOP_KEYS)) return false
  return (
    typeof value.preset === 'string' &&
    LOOP_SET.has(value.preset) &&
    inRange(value.duration, 'loopDuration') &&
    (value.direction === undefined ||
      (typeof value.direction === 'string' && DIRECTION_SET.has(value.direction)))
  )
}

function isParallax(value: unknown): value is DesignMotionParallax {
  return isPlainObject(value) && onlyKeys(value, PARALLAX_KEYS) && inRange(value.factor, 'factor')
}

// Unknown keys are refused so a typo ("durration") never persists silently.
// An empty object is valid (and equals "no motion").
export function isMotion(value: unknown): value is DesignMotion {
  if (!isPlainObject(value) || !onlyKeys(value, MOTION_KEYS)) return false
  return (
    (value.entrance === undefined || isEntrance(value.entrance)) &&
    (value.hover === undefined || isHover(value.hover)) &&
    (value.loop === undefined || isLoop(value.loop)) &&
    (value.parallax === undefined || isParallax(value.parallax))
  )
}

// ---- normalisation (defaults + clamping; what the inspector and MCP send) ----

type Loose<T> = { [K in keyof T]?: unknown }

export interface DesignMotionInput {
  entrance?: Loose<DesignMotionEntrance> | null
  hover?: Loose<DesignMotionHover> | null
  loop?: Loose<DesignMotionLoop> | null
  parallax?: Loose<DesignMotionParallax> | null
}

function pick<T extends string>(value: unknown, set: ReadonlySet<string>, what: string): T {
  if (typeof value !== 'string' || !set.has(value)) {
    throw new Error(`invalid ${what} "${String(value)}"; use ${[...set].join(', ')}`)
  }
  return value as T
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return value === undefined || value === null || Number.isNaN(n) ? fallback : n
}

// Fills defaults and clamps into range; throws on an unknown preset/easing.
// Returns null when no section is enabled so "clear" and "empty" agree.
export function normalizeMotion(input: DesignMotionInput | null | undefined): DesignMotion | null {
  if (!input) return null
  const out: DesignMotion = {}
  if (input.entrance) {
    const e = input.entrance
    const entrance: DesignMotionEntrance = {
      preset: pick<EntrancePreset>(e.preset, ENTRANCE_SET, 'entrance preset'),
      trigger:
        e.trigger === undefined ? 'load' : pick<EntranceTrigger>(e.trigger, TRIGGER_SET, 'trigger'),
      duration: clampTo(num(e.duration, MOTION_DEFAULTS.duration), 'duration', 0),
      delay: clampTo(num(e.delay, MOTION_DEFAULTS.delay), 'delay', 0),
      easing:
        e.easing === undefined
          ? MOTION_DEFAULTS.easing
          : pick<DesignEasing>(e.easing, EASING_SET, 'easing'),
    }
    if (e.distance !== undefined && e.distance !== null) {
      entrance.distance = clampTo(num(e.distance, MOTION_DEFAULTS.distance), 'distance', 0)
    }
    if (e.stagger !== undefined && e.stagger !== null) {
      const stagger = clampTo(num(e.stagger, 0), 'stagger', 0)
      if (stagger > 0) entrance.stagger = stagger
    }
    out.entrance = entrance
  }
  if (input.hover) {
    const h = input.hover
    const hover: DesignMotionHover = {
      preset: pick<HoverPreset>(h.preset, HOVER_SET, 'hover preset'),
      duration: clampTo(num(h.duration, MOTION_DEFAULTS.hoverDuration), 'duration', 0),
      easing:
        h.easing === undefined
          ? MOTION_DEFAULTS.easing
          : pick<DesignEasing>(h.easing, EASING_SET, 'easing'),
    }
    if (h.intensity !== undefined && h.intensity !== null) {
      hover.intensity = clampTo(num(h.intensity, MOTION_DEFAULTS.intensity), 'intensity', 2)
    }
    out.hover = hover
  }
  if (input.loop) {
    const l = input.loop
    const loop: DesignMotionLoop = {
      preset: pick<LoopPreset>(l.preset, LOOP_SET, 'loop preset'),
      duration: clampTo(num(l.duration, MOTION_DEFAULTS.loopDuration), 'loopDuration', 0),
    }
    if (l.direction !== undefined && l.direction !== null) {
      loop.direction = pick<LoopDirection>(l.direction, DIRECTION_SET, 'loop direction')
    }
    out.loop = loop
  }
  if (input.parallax) {
    out.parallax = {
      factor: clampTo(num(input.parallax.factor, 0), 'factor', 2),
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

export function treeHasMotion(tree: DesignNode): boolean {
  if (tree.motion && Object.keys(tree.motion).length > 0) return true
  return tree.children.some(treeHasMotion)
}

// One line for the agent: "in: slide-up 240ms +stagger 60 · hover: lift · loop: marquee".
export function motionSummary(motion: DesignMotion): string {
  const parts: string[] = []
  if (motion.entrance) {
    const e = motion.entrance
    let s = `in: ${e.preset} ${e.duration}ms`
    if (e.trigger === 'in-view') s += ' in-view'
    if (e.delay) s += ` +${e.delay}`
    if (e.stagger) s += ` +stagger ${e.stagger}`
    parts.push(s)
  }
  if (motion.hover) parts.push(`hover: ${motion.hover.preset}`)
  if (motion.loop) parts.push(`loop: ${motion.loop.preset} ${motion.loop.duration}ms`)
  if (motion.parallax) parts.push(`parallax: ${motion.parallax.factor}`)
  return parts.join(' · ')
}

// Smart Animate pairs nodes by name: "Hero Title" ↔ view-transition-name:pw-hero-title.
export function viewTransitionName(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug ? `pw-${slug}` : null
}

export { EASING_CSS, springLinear } from './motion-easing'

// ---- projection: node.motion → attributes + CSS variables ----

export interface MotionContext {
  // Position among the parent's children and the parent's stagger (ms):
  // the parent's entrance then plays on this child, offset by index * stagger.
  index?: number
  stagger?: number
  parentEntrance?: DesignMotionEntrance
}

export interface MotionAttrs {
  // data-pw-m-* attributes (rendered in every mode, the export included).
  attrs: Record<string, string>
  // --pw-* variables appended to the style AFTER the user's declarations.
  vars: Record<string, string>
}

function entranceVars(e: DesignMotionEntrance, vars: Record<string, string>): void {
  vars['--pw-dur'] = `${e.duration}ms`
  vars['--pw-delay'] = `${e.delay}ms`
  vars['--pw-ease'] = EASING_CSS[e.easing]
  vars['--pw-dist'] = `${e.distance ?? MOTION_DEFAULTS.distance}px`
}

export function motionAttrs(node: DesignNode, ctx: MotionContext = {}): MotionAttrs {
  const attrs: Record<string, string> = {}
  const vars: Record<string, string> = {}
  const motion = node.motion
  const own = motion?.entrance
  if (own && own.stagger) {
    // The list itself only announces the stagger; its children animate.
    attrs['data-pw-m-stagger'] = String(own.stagger)
  } else if (own) {
    attrs['data-pw-m-in'] = own.preset
    attrs['data-pw-m-trigger'] = own.trigger
    entranceVars(own, vars)
  } else if (ctx.parentEntrance && ctx.stagger && ctx.index !== undefined) {
    const e = ctx.parentEntrance
    attrs['data-pw-m-in'] = e.preset
    attrs['data-pw-m-trigger'] = e.trigger
    entranceVars(e, vars)
    vars['--pw-i'] = String(ctx.index)
    vars['--pw-stagger'] = `${ctx.stagger}ms`
  }
  if (motion?.hover) {
    attrs['data-pw-m-hover'] = motion.hover.preset
    vars['--pw-hdur'] = `${motion.hover.duration}ms`
    vars['--pw-hease'] = EASING_CSS[motion.hover.easing]
    vars['--pw-int'] = String(motion.hover.intensity ?? MOTION_DEFAULTS.intensity)
  }
  if (motion?.loop) {
    attrs['data-pw-m-loop'] = motion.loop.preset
    vars['--pw-loop-dur'] = `${motion.loop.duration}ms`
    vars['--pw-loop-dir'] = motion.loop.direction ?? MOTION_DEFAULTS.loopDirection
  }
  if (motion?.parallax) {
    attrs['data-pw-m-par'] = String(motion.parallax.factor)
    vars['--pw-par'] = String(motion.parallax.factor)
  }
  return { attrs, vars }
}

// Context the children of `node` render with (renderTree / runtime insert).
export function childMotionContext(node: DesignNode, index: number): MotionContext {
  const e = node.motion?.entrance
  if (!e || !e.stagger) return {}
  return { index, stagger: e.stagger, parentEntrance: e }
}
