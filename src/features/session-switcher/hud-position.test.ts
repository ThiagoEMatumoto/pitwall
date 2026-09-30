import { describe, expect, it } from 'vitest'
import { HUD_GAP, hudTop } from './hud-position'

const base = { titlebarBottom: 40, tabsBottom: null, peek: null, viewportHeight: 900, hudHeight: 28 }

describe('hudTop', () => {
  it('abaixo da titlebar fora da área de projetos', () => {
    expect(hudTop(base)).toBe(40 + HUD_GAP)
  })

  it('abaixo da faixa de abas do dockview, sem cobri-la', () => {
    expect(hudTop({ ...base, tabsBottom: 75 })).toBe(75 + HUD_GAP)
  })

  it('com o peek aberto, no respiro acima do painel sem encostar', () => {
    const top = hudTop({ ...base, tabsBottom: 75, peek: { top: 54, bottom: 846 } })
    expect(top + base.hudHeight).toBeLessThan(54)
    expect(top).toBeGreaterThan(0)
  })

  it('sem espaço acima do peek, vai pro respiro de baixo', () => {
    const top = hudTop({ ...base, viewportHeight: 600, peek: { top: 30, bottom: 560 } })
    expect(top).toBeGreaterThan(560)
    expect(top + base.hudHeight).toBeLessThanOrEqual(600)
  })
})
