import { describe, expect, it } from 'vitest'
import { providerSupportsTuiMenus } from './registry'

describe('providerSupportsTuiMenus', () => {
  it('claude (e linha legada sem provider) tem menus; id desconhecido não lança', () => {
    expect(providerSupportsTuiMenus('claude')).toBe(true)
    expect(providerSupportsTuiMenus(null)).toBe(true)
    expect(providerSupportsTuiMenus('codex' as never)).toBe(false)
  })
})
