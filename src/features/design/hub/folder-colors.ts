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

export function folderColorCss(color: string | null): string {
  if (!color) return 'var(--color-text-dim)'
  return KEYS.has(color) ? `var(--color-${color})` : color
}
