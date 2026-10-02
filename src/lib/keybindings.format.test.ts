import { describe, expect, it } from 'vitest'
import { formatCombo } from './keybindings'

describe('formatCombo', () => {
  it('tecla nomeada não vira caixa alta', () => {
    expect(formatCombo({ mod: true, shift: true, key: 'Enter' })).toMatch(/\+Shift\+Enter$/)
  })
  it('letra solta segue maiúscula', () => {
    expect(formatCombo({ mod: true, key: 'k' })).toMatch(/\+K$/)
  })
})
