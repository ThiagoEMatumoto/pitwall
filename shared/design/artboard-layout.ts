// Where an artboard lands when nobody says where. Shared so the canvas store,
// the MCP tools and the duplicate path place frames the same way.

import { ARTBOARD_GAP } from './safety'

export interface PlacedArtboard {
  x: number
  width: number
}

// A new artboard goes after the rightmost one on the page.
export function nextArtboardX(existing: readonly PlacedArtboard[]): number {
  if (existing.length === 0) return 0
  return Math.max(...existing.map((a) => a.x + a.width)) + ARTBOARD_GAP
}

// A copy goes immediately to the right of its original.
export function duplicateArtboardX(source: PlacedArtboard): number {
  return source.x + source.width + ARTBOARD_GAP
}
