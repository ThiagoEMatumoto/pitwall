import { describe, expect, it } from 'vitest'
import { FOLDER_COLORS, folderColorCss, folderDotStyle } from './folder-colors'

describe('folder colors', () => {
  it('a folder without color is a neutral ring, never one of the pickable fills', () => {
    const none = folderDotStyle(null)
    expect(none.background).toBeUndefined()
    expect(none.boxShadow).toContain('var(--color-text-dim)')
    for (const { key } of FOLDER_COLORS) {
      expect(folderDotStyle(key)).toEqual({ background: `var(--color-${key})` })
    }
    expect(folderDotStyle('info')).not.toEqual(none)
  })

  it('a color outside the palette (set by Claude via MCP) renders verbatim', () => {
    expect(folderColorCss('#f00')).toBe('#f00')
    expect(folderDotStyle('#f00')).toEqual({ background: '#f00' })
  })
})
