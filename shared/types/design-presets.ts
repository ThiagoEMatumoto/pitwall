// Artboard size presets offered by the UI and listed in the MCP guide.
// Re-exported from ./design so callers keep one import surface.

import type { ArtboardSizing } from './design'
import { DEFAULT_ARTBOARD_HEIGHT_PX } from '../design/safety'

export type ArtboardPresetGroup = 'desktop' | 'mobile' | 'large' | 'landing'

export interface ArtboardPreset {
  id: string
  label: string
  group: ArtboardPresetGroup
  width: number
  // For a flow preset this is only the starting height; the content decides.
  height: number
  sizing: ArtboardSizing
}

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
]
