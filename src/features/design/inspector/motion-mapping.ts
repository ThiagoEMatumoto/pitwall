// DesignMotion ↔ inspector values. The tree stores only what is set; the
// controls always show a full row of numbers, so reading fills the defaults
// and writing goes through normalizeMotion (clamp + drop the empties).

import { MOTION_DEFAULTS, normalizeMotion, type DesignMotionInput } from '@shared/design/motion'
import type {
  DesignEasing,
  DesignMotion,
  DesignNode,
  EntrancePreset,
  EntranceTrigger,
  HoverPreset,
  LoopDirection,
  LoopPreset,
} from '@shared/types/design'
import { getStyle } from './style-mapping'

export interface EntranceUi {
  preset: EntrancePreset
  trigger: EntranceTrigger
  duration: number
  delay: number
  easing: DesignEasing
  distance: number
  // 0 = the node itself animates; > 0 = its children, one after the other.
  stagger: number
}

export interface HoverUi {
  preset: HoverPreset
  duration: number
  easing: DesignEasing
  intensity: number
}

export interface LoopUi {
  preset: LoopPreset
  duration: number
  direction: LoopDirection
}

export interface ParallaxUi {
  factor: number
}

export interface MotionUi {
  entrance: EntranceUi | null
  hover: HoverUi | null
  loop: LoopUi | null
  parallax: ParallaxUi | null
}

export type MotionSectionKey = keyof MotionUi

export const ENTRANCE_UI_DEFAULTS: EntranceUi = {
  preset: 'fade',
  trigger: 'load',
  duration: MOTION_DEFAULTS.duration,
  delay: MOTION_DEFAULTS.delay,
  easing: MOTION_DEFAULTS.easing,
  distance: MOTION_DEFAULTS.distance,
  stagger: 0,
}

export const HOVER_UI_DEFAULTS: HoverUi = {
  preset: 'lift',
  duration: MOTION_DEFAULTS.hoverDuration,
  easing: MOTION_DEFAULTS.easing,
  intensity: MOTION_DEFAULTS.intensity,
}

export const LOOP_UI_DEFAULTS: LoopUi = {
  preset: 'pulse',
  duration: MOTION_DEFAULTS.loopDuration,
  direction: MOTION_DEFAULTS.loopDirection,
}

// A factor of 0 is "no parallax", so enabling starts at a visible value.
export const PARALLAX_UI_DEFAULTS: ParallaxUi = { factor: 0.2 }

const SLIDE_PRESETS: ReadonlySet<EntrancePreset> = new Set([
  'slide-up',
  'slide-down',
  'slide-left',
  'slide-right',
])

export function usesDistance(preset: EntrancePreset): boolean {
  return SLIDE_PRESETS.has(preset)
}

export function readMotionUi(motion: DesignMotion | undefined): MotionUi {
  return {
    entrance: motion?.entrance
      ? {
          preset: motion.entrance.preset,
          trigger: motion.entrance.trigger,
          duration: motion.entrance.duration,
          delay: motion.entrance.delay,
          easing: motion.entrance.easing,
          distance: motion.entrance.distance ?? ENTRANCE_UI_DEFAULTS.distance,
          stagger: motion.entrance.stagger ?? 0,
        }
      : null,
    hover: motion?.hover
      ? {
          preset: motion.hover.preset,
          duration: motion.hover.duration,
          easing: motion.hover.easing,
          intensity: motion.hover.intensity ?? HOVER_UI_DEFAULTS.intensity,
        }
      : null,
    loop: motion?.loop
      ? {
          preset: motion.loop.preset,
          duration: motion.loop.duration,
          direction: motion.loop.direction ?? LOOP_UI_DEFAULTS.direction,
        }
      : null,
    parallax: motion?.parallax ? { factor: motion.parallax.factor } : null,
  }
}

// Optional fields equal to their default stay out of the tree: a hover at
// intensity 1 or a loop running "normal" is the preset, not a setting.
function orDefault<T>(value: T, fallback: T): T | undefined {
  return value === fallback ? undefined : value
}

function toInput(ui: MotionUi): DesignMotionInput {
  const input: DesignMotionInput = {}
  if (ui.entrance) {
    const e = ui.entrance
    input.entrance = {
      preset: e.preset,
      trigger: e.trigger,
      duration: e.duration,
      delay: e.delay,
      easing: e.easing,
      distance: usesDistance(e.preset)
        ? orDefault(e.distance, ENTRANCE_UI_DEFAULTS.distance)
        : undefined,
      stagger: e.stagger,
    }
  }
  if (ui.hover) {
    input.hover = {
      ...ui.hover,
      intensity: orDefault(ui.hover.intensity, HOVER_UI_DEFAULTS.intensity),
    }
  }
  if (ui.loop) {
    input.loop = { ...ui.loop, direction: orDefault(ui.loop.direction, LOOP_UI_DEFAULTS.direction) }
  }
  if (ui.parallax) input.parallax = { ...ui.parallax }
  return input
}

// Replaces one section (null = off) and returns the motion to store; null
// when nothing is left on, so "clear" and "empty" agree with the runtime.
export function writeMotionSection<K extends MotionSectionKey>(
  motion: DesignMotion | undefined,
  key: K,
  value: MotionUi[K] | null,
): DesignMotion | null {
  const ui = readMotionUi(motion)
  return normalizeMotion(toInput({ ...ui, [key]: value }))
}

export function hasMotion(node: Pick<DesignNode, 'motion'>): boolean {
  return !!node.motion && Object.keys(node.motion).length > 0
}

// Entrance and loop keyframes animate transform, so a transform in the
// user's style is replaced while they play; hover and parallax move through
// translate/scale and compose with it.
export function hasUserTransform(node: Pick<DesignNode, 'style'>): boolean {
  const value = getStyle(node.style, 'transform')
  return value != null && value.trim() !== '' && value.trim() !== 'none'
}

export const SECTION_LABELS: Record<MotionSectionKey, string> = {
  entrance: 'Entrada',
  hover: 'Hover',
  loop: 'Loop',
  parallax: 'Parallax',
}

export const ENTRANCE_PRESET_LABELS: Record<EntrancePreset, string> = {
  fade: 'Fade',
  'slide-up': '↑',
  'slide-down': '↓',
  'slide-left': '←',
  'slide-right': '→',
  scale: 'Scale',
  blur: 'Blur',
}

export const TRIGGER_LABELS: Record<EntranceTrigger, string> = {
  load: 'Ao abrir',
  'in-view': 'Ao aparecer',
}

export const HOVER_PRESET_LABELS: Record<HoverPreset, string> = {
  lift: 'Lift',
  scale: 'Scale',
  glow: 'Glow',
  color: 'Cor',
}

export const LOOP_PRESET_LABELS: Record<LoopPreset, string> = {
  pulse: 'Pulse',
  marquee: 'Marquee',
  float: 'Float',
  spin: 'Spin',
}

export const LOOP_DIRECTION_LABELS: Record<LoopDirection, string> = {
  normal: 'Normal',
  reverse: 'Reverso',
  alternate: 'Vai e volta',
}

export const EASING_LABELS: Record<DesignEasing, string> = {
  'ease-out': 'Ease out',
  'ease-in-out': 'Ease in-out',
  linear: 'Linear',
  back: 'Back',
  'spring-gentle': 'Spring suave',
  'spring-quick': 'Spring rápido',
  'spring-bouncy': 'Spring saltitante',
}
