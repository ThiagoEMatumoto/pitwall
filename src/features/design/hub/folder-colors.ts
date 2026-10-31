import type { CSSProperties } from 'react'

// Folder colors are stored as theme token keys, so a folder follows the theme
// (all four). Anything else (Claude may set '#f00' via MCP) renders verbatim.
export const FOLDER_COLORS = [
  { key: 'accent', label: 'Destaque' },
  { key: 'accent2', label: 'Secundária' },
  { key: 'info', label: 'Azul' },
  { key: 'success', label: 'Verde' },
  { key: 'warning', label: 'Âmbar' },
  { key: 'danger', label: 'Coral' },
] as const

const KEYS = new Set<string>(FOLDER_COLORS.map((c) => c.key))

export function folderColorCss(color: string): string {
  return KEYS.has(color) ? `var(--color-${color})` : color
}

// No color is a hollow ring, not a fill: at dot size the dim text token reads
// as the same blue as 'info', and a ring can't be mistaken for any swatch.
export function folderDotStyle(color: string | null): CSSProperties {
  if (!color) return { boxShadow: 'inset 0 0 0 1.5px var(--color-text-dim)' }
  return { background: folderColorCss(color) }
}
