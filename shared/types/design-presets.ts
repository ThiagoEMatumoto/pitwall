// Artboard size presets offered by the UI and listed in the MCP guide.
// Re-exported from ./design so callers keep one import surface.

import type { ArtboardSizing } from './design'
import { DEFAULT_ARTBOARD_HEIGHT_PX, clampArtboardSize } from '../design/safety'

export type ArtboardPresetGroup =
  | 'desktop'
  | 'mobile'
  | 'large'
  | 'landing'
  | 'document'
  | 'presentation'
  // Only the size typed in the "Personalizado…" dialog; never listed in a menu.
  | 'custom'

export interface ArtboardPreset {
  id: string
  label: string
  group: ArtboardPresetGroup
  width: number
  // For a flow preset this is only the starting height; the content decides.
  height: number
  sizing: ArtboardSizing
}

// Paper sizes at 96 DPI (1 css px = 1/96 in), so 1 px here is 1 px in the PDF
// export: A4 = 210×297 mm, Letter = 8.5×11 in.
export const ARTBOARD_PRESETS: readonly ArtboardPreset[] = [
  { id: 'desktop', label: 'Desktop', group: 'desktop', width: 1440, height: 900, sizing: 'fixed' },
  {
    id: 'desktop-hd',
    label: 'Desktop HD',
    group: 'desktop',
    width: 1920,
    height: 1080,
    sizing: 'fixed',
  },
  { id: '2k', label: '2K', group: 'large', width: 2560, height: 1440, sizing: 'fixed' },
  { id: '4k', label: '4K', group: 'large', width: 3840, height: 2160, sizing: 'fixed' },
  { id: 'tablet', label: 'Tablet', group: 'mobile', width: 834, height: 1194, sizing: 'fixed' },
  { id: 'mobile', label: 'Mobile', group: 'mobile', width: 390, height: 844, sizing: 'fixed' },
  {
    id: 'landing',
    label: 'Landing',
    group: 'landing',
    width: 1440,
    height: DEFAULT_ARTBOARD_HEIGHT_PX,
    sizing: 'flow',
  },
  {
    id: 'landing-mobile',
    label: 'Landing mobile',
    group: 'landing',
    width: 390,
    height: DEFAULT_ARTBOARD_HEIGHT_PX,
    sizing: 'flow',
  },
  { id: 'a4', label: 'A4 retrato', group: 'document', width: 794, height: 1123, sizing: 'fixed' },
  {
    id: 'a4-landscape',
    label: 'A4 paisagem',
    group: 'document',
    width: 1123,
    height: 794,
    sizing: 'fixed',
  },
  {
    id: 'letter',
    label: 'Letter retrato',
    group: 'document',
    width: 816,
    height: 1056,
    sizing: 'fixed',
  },
  {
    id: 'letter-landscape',
    label: 'Letter paisagem',
    group: 'document',
    width: 1056,
    height: 816,
    sizing: 'fixed',
  },
  {
    id: 'slide-16-9',
    label: 'Slide 16:9',
    group: 'presentation',
    width: 1920,
    height: 1080,
    sizing: 'fixed',
  },
]

export const CUSTOM_PRESET_ID = 'custom'

// A size the user typed. Same shape as a listed preset so createArtboard and
// the inspector keep taking one thing.
export function customPreset(width: number, height: number): ArtboardPreset {
  return {
    id: CUSTOM_PRESET_ID,
    label: 'Personalizado',
    group: 'custom',
    width: clampArtboardSize(width),
    height: clampArtboardSize(height),
    sizing: 'fixed',
  }
}
