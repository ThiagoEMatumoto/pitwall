// Self-correction rounds. Each fix targets a node by its data-name (never an
// invented id: the scenario resolves ids through design_children_get) and
// applies the smallest surgery: a style patch or a text change. Rounds are
// filled in after reading the design_screenshot PNGs of the previous round.
import type { ArtboardKey } from './session'

export interface Fix {
  artboard: ArtboardKey
  name: string
  // Style patch (null removes a property).
  style?: Record<string, string | null>
  text?: string
  why: string
}

export const ROUNDS: Fix[][] = [
  // round 1
  [],
  // round 2
  [],
]
