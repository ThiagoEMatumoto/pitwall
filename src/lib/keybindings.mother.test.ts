import { describe, expect, it } from 'vitest'
import {
  COMMANDS,
  formatCombo,
  matchCombo,
  resolveCombo,
  setKeyboardLayoutLabels,
} from './keybindings'

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

// Ctrl+Shift+P: mostrar/esconder o painel da mãe (o Ctrl+Shift+M é o ditado).
describe('mother.togglePanel', () => {
  const combo = resolveCombo('mother.togglePanel', {})
  const press = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)
  const key = (c: typeof combo) =>
    JSON.stringify([!!c.mod, !!c.shift, !!c.alt, c.code ?? `Key${(c.key ?? '').toUpperCase()}`])

  it('é Ctrl+Shift+P por code', () => {
    expect(
      matchCombo(press({ ctrlKey: true, shiftKey: true, code: 'KeyP', key: 'P' }), combo),
    ).toBe(true)
    expect(formatCombo(combo)).toMatch(/Shift\+P$/)
  })

  it('não colide com outro atalho do app (nem com o ditado)', () => {
    const others = COMMANDS.filter((c) => c.id !== 'mother.togglePanel').map((c) =>
      key(c.defaultCombo),
    )
    expect(others).not.toContain(key(combo))
    expect(key(resolveCombo('session.dictate', {}))).not.toBe(key(combo))
  })

  it('não engole o meta+p do Claude Code', () => {
    expect(matchCombo(press({ altKey: true, code: 'KeyP' }), combo)).toBe(false)
    expect(matchCombo(press({ metaKey: true, code: 'KeyP' }), combo)).toBe(false)
  })
})

// ABNT2: a Backquote (acima do Tab) imprime ' — "Ctrl+`" mandava apertar a tecla errada.
describe('rótulo da tecla no layout', () => {
  it('formatCombo usa o que a tecla física imprime; sem layout, o rótulo US', () => {
    const combo = resolveCombo('featureSwitcher.open', {})
    expect(formatCombo(combo)).toBe('Ctrl+`')
    setKeyboardLayoutLabels(new Map([['Backquote', "'"]]))
    try {
      expect(formatCombo(combo)).toBe("Ctrl+'")
    } finally {
      setKeyboardLayoutLabels(new Map())
    }
  })
})
