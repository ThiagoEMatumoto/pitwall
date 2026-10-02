import { describe, expect, it } from 'vitest'
import { COMMANDS, formatCombo, matchCombo, resolveCombo } from './keybindings'

// Ctrl+Shift+O: ir à mãe. Não pode casar com nenhum outro default do app nem
// com os meta+letra do Claude Code 2.1.286 (meta+p/o/t/m, meta+↑/↓).
describe('mother.focus', () => {
  const combo = resolveCombo('mother.focus', {})
  const press = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)

  it('é Ctrl+Shift+O por code', () => {
    expect(
      matchCombo(press({ ctrlKey: true, shiftKey: true, code: 'KeyO', key: 'O' }), combo),
    ).toBe(true)
    expect(formatCombo(combo)).toMatch(/Shift\+O$/)
  })

  it('não colide com outro atalho do app', () => {
    const key = (c: typeof combo) =>
      JSON.stringify([!!c.mod, !!c.shift, !!c.alt, c.code ?? `Key${(c.key ?? '').toUpperCase()}`])
    const others = COMMANDS.filter((c) => c.id !== 'mother.focus').map((c) => key(c.defaultCombo))
    expect(others).not.toContain(key(combo))
  })

  it('não engole o meta+letra do Claude Code', () => {
    for (const code of ['KeyP', 'KeyO', 'KeyT', 'KeyM']) {
      expect(matchCombo(press({ altKey: true, code }), combo)).toBe(false)
      expect(matchCombo(press({ metaKey: true, code }), combo)).toBe(false)
    }
  })
})
