import { describe, expect, it } from 'vitest'
import { headerLayout } from './header-layout'

describe('headerLayout', () => {
  it('720px: linha inteira', () => {
    expect(headerLayout(720)).toEqual({
      featureLinkIconOnly: false,
      chipsShrink: false,
      secondaryInMenu: false,
      toggleInMenu: false,
    })
  })
  it('480px: vínculo vira ícone, chips truncam, ações secundárias no "…"', () => {
    expect(headerLayout(480)).toEqual({
      featureLinkIconOnly: true,
      chipsShrink: true,
      secondaryInMenu: true,
      toggleInMenu: false,
    })
  })
  it('320px: o toggle também vai para o "…"', () => {
    expect(headerLayout(320).toggleInMenu).toBe(true)
    expect(headerLayout(320).secondaryInMenu).toBe(true)
  })
  it('sem medição: linha inteira', () => {
    expect(headerLayout(undefined).secondaryInMenu).toBe(false)
  })
})
