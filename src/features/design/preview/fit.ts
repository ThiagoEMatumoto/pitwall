// Pure preview scaling. Short artboards fit whole; tall ones (flow, or fixed
// but much taller than the stage) fit by width and scroll in the stage.

import type { ArtboardSizing } from '@shared/types/design'

export type ScaleMode = 'fit' | 'actual'

export interface Size {
  w: number
  h: number
}

// Fitting the whole artboard would shrink it to under half of the width-fit
// scale: better to keep it readable and let the stage scroll.
export const TALL_FIT_RATIO = 2

export function fitsByWidth(artboard: Size, viewport: Size, sizing: ArtboardSizing): boolean {
  if (sizing === 'flow') return true
  if (artboard.w <= 0 || artboard.h <= 0 || viewport.w <= 0 || viewport.h <= 0) return false
  // Capped like fitScale: a phone that fits whole at 1:1 is not "tall".
  const byWidth = Math.min(1, viewport.w / artboard.w)
  const byHeight = Math.min(1, viewport.h / artboard.h)
  return byWidth / byHeight >= TALL_FIT_RATIO
}

// Fit never upscales: a 390px mobile artboard stays 390px on a 4K screen.
export function fitScale(
  artboard: Size,
  viewport: Size,
  mode: ScaleMode,
  padding = 0,
  sizing: ArtboardSizing = 'fixed',
): number {
  if (mode === 'actual') return 1
  const avail = { w: viewport.w - padding * 2, h: viewport.h - padding * 2 }
  if (avail.w <= 0 || avail.h <= 0 || artboard.w <= 0 || artboard.h <= 0) return 1
  if (fitsByWidth(artboard, avail, sizing)) return Math.min(1, avail.w / artboard.w)
  return Math.min(1, avail.w / artboard.w, avail.h / artboard.h)
}
