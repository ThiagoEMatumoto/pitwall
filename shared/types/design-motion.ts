// Motion and transition vocabulary of the design tree (re-exported from ./design). Presets
// are closed enums: the CSS sheet (shared/design/motion-css.ts) has one rule
// per value, so a new preset is a change here, in motion.ts and in the sheet.

// smart = View Transitions matching nodes by name across the two artboards.
export type DesignTransition = 'none' | 'push' | 'fade' | 'smart'

export interface DesignNodeLink {
  artboardId: string
  transition: DesignTransition
  // ms; omitted = the preview's default for that transition.
  duration?: number
  easing?: DesignEasing
}

// Springs are approximated with CSS linear() (shared/design/motion.ts).
export type DesignEasing =
  | 'ease-out'
  | 'ease-in-out'
  | 'linear'
  | 'back'
  | 'spring-gentle'
  | 'spring-quick'
  | 'spring-bouncy'

// ---- motion (presets per node; parameters live in CSS variables) ----

export type EntrancePreset =
  'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right' | 'scale' | 'blur'
export type EntranceTrigger = 'load' | 'in-view'
export type HoverPreset = 'lift' | 'scale' | 'glow' | 'color'
export type LoopPreset = 'pulse' | 'marquee' | 'float' | 'spin'
export type LoopDirection = 'normal' | 'reverse' | 'alternate'

export interface DesignMotionEntrance {
  preset: EntrancePreset
  trigger: EntranceTrigger
  // ms
  duration: number
  // ms
  delay: number
  easing: DesignEasing
  // px travelled by the slide presets.
  distance?: number
  // ms between siblings: when set, the entrance plays on each CHILD of this
  // node (index * stagger added to the delay) instead of on the node itself.
  stagger?: number
}

export interface DesignMotionHover {
  preset: HoverPreset
  duration: number
  easing: DesignEasing
  // 0.1..3, multiplies the preset's displacement/scale/glow. Default 1.
  intensity?: number
}

export interface DesignMotionLoop {
  preset: LoopPreset
  // ms per cycle.
  duration: number
  direction?: LoopDirection
}

export interface DesignMotionParallax {
  // -1..1: fraction of the scroll offset applied against the scroll direction.
  factor: number
}

export interface DesignMotion {
  entrance?: DesignMotionEntrance
  hover?: DesignMotionHover
  loop?: DesignMotionLoop
  parallax?: DesignMotionParallax
}
