// How the chrome prints artboard sizes and groups the size presets. A flow
// artboard has a fixed width and a measured height, so "1440×fluxo (2340)"
// says both without pretending the height is a setting.

import type { ArtboardPreset, ArtboardPresetGroup, ArtboardSizing } from '@shared/types/design'
import { ARTBOARD_PRESETS } from '@shared/types/design'

export const FLOW_LABEL = 'fluxo'

export interface ArtboardSizeLike {
  width: number
  height: number
  sizing: ArtboardSizing
}

export function formatArtboardSize(meta: ArtboardSizeLike): string {
  if (meta.sizing === 'flow') return `${meta.width}×${FLOW_LABEL} (${meta.height})`
  return `${meta.width}×${meta.height}`
}

// A flow preset has no measured height yet: only the width is a promise.
export function formatPresetSize(preset: ArtboardPreset): string {
  if (preset.sizing === 'flow') return `${preset.width}×${FLOW_LABEL}`
  return `${preset.width}×${preset.height}`
}

export const PRESET_GROUP_LABELS: Record<ArtboardPresetGroup, string> = {
  desktop: 'Desktop',
  mobile: 'Mobile',
  large: 'Grandes',
  landing: 'Landing',
}

const GROUP_ORDER: readonly ArtboardPresetGroup[] = ['desktop', 'mobile', 'large', 'landing']

export interface PresetGroup {
  group: ArtboardPresetGroup
  label: string
  presets: ArtboardPreset[]
}

export function groupPresets(presets: readonly ArtboardPreset[] = ARTBOARD_PRESETS): PresetGroup[] {
  return GROUP_ORDER.map((group) => ({
    group,
    label: PRESET_GROUP_LABELS[group],
    presets: presets.filter((p) => p.group === group),
  })).filter((g) => g.presets.length > 0)
}

export function presetMatches(preset: ArtboardPreset, meta: ArtboardSizeLike): boolean {
  if (preset.sizing !== meta.sizing || preset.width !== meta.width) return false
  return preset.sizing === 'flow' || preset.height === meta.height
}
