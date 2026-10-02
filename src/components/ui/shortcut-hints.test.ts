import { describe, expect, it } from 'vitest'
import { hintText } from './shortcut-hints'

describe('hintText', () => {
  it('teclas alternativas com barra, dicas separadas por ponto', () => {
    expect(
      hintText([
        { keys: ['Alt+,', 'Alt+.'], label: 'trocar' },
        { keys: ['Esc'], label: 'fechar' },
      ]),
    ).toBe('Alt+, / Alt+. trocar · Esc fechar')
  })
})
