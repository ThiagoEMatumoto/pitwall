import { describe, expect, it } from 'vitest'
import {
  COMPOSER_TIERS,
  composerToolbarLayout,
  MIN_INLINE_ICONS,
  type ToolbarControl,
} from './composer-layout'
import { panelTierFor, type PanelTier } from './use-panel-tier'

const TIERS: PanelTier[] = ['wide', 'mid', 'narrow']
const ALL: ToolbarControl[] = [
  'model',
  'effort',
  'permission',
  'interrupt',
  'mic',
  'summarize',
  'autoSummary',
]

describe('composerToolbarLayout', () => {
  it('wide mantém os 7 controles inline, na ordem canônica', () => {
    expect(composerToolbarLayout('wide')).toEqual({
      inline: ALL,
      overflow: [],
    })
  })

  it('mid manda resumo e auto-resumo pro overflow', () => {
    expect(composerToolbarLayout('mid')).toEqual({
      inline: ['model', 'effort', 'permission', 'interrupt', 'mic'],
      overflow: ['summarize', 'autoSummary'],
    })
  })

  it('narrow deixa inline só o essencial de sessão', () => {
    expect(composerToolbarLayout('narrow')).toEqual({
      inline: ['model', 'interrupt', 'mic'],
      overflow: ['effort', 'permission', 'summarize', 'autoSummary'],
    })
  })
})

describe('invariantes de layout', () => {
  it('nenhum controle some nem aparece duas vezes em nenhum tier', () => {
    for (const tier of TIERS) {
      const { inline, overflow } = composerToolbarLayout(tier)
      const all = [...inline, ...overflow]
      expect(all).toHaveLength(ALL.length)
      expect(new Set(all)).toEqual(new Set(ALL))
    }
  })

  it('model, interrupt e mic nunca caem no overflow', () => {
    for (const tier of TIERS) {
      const { overflow } = composerToolbarLayout(tier)
      expect(overflow).not.toContain('model')
      expect(overflow).not.toContain('interrupt')
      expect(overflow).not.toContain('mic')
    }
  })
})

describe('tiers do composer', () => {
  it('228px cai em narrow — nos limites default virava mid e a barra estourava', () => {
    expect(panelTierFor(228, COMPOSER_TIERS)).toBe('narrow')
  })

  it('227px cai em narrow', () => {
    expect(panelTierFor(227, COMPOSER_TIERS)).toBe('narrow')
  })

  it('450px cai em mid', () => {
    expect(panelTierFor(450, COMPOSER_TIERS)).toBe('mid')
  })

  it('700px cai em wide', () => {
    expect(panelTierFor(700, COMPOSER_TIERS)).toBe('wide')
  })

  it('sem thresholds, os limites default do header seguem intactos', () => {
    expect(panelTierFor(228)).toBe('mid')
    expect(panelTierFor(220)).toBe('narrow')
    expect(panelTierFor(421)).toBe('wide')
  })
})

describe('piso de largura', () => {
  const BELOW = MIN_INLINE_ICONS - 14 // 126px: o pane medido no app que cortava o "⋯"

  it('abaixo do piso sobra inline só o interrupt, o resto vai pro overflow', () => {
    expect(composerToolbarLayout('narrow', BELOW)).toEqual({
      inline: ['interrupt'],
      overflow: ['model', 'effort', 'permission', 'mic', 'summarize', 'autoSummary'],
    })
  })

  it('o piso vence o tier — wide e mid colapsam igual', () => {
    for (const tier of ['wide', 'mid'] as PanelTier[]) {
      expect(composerToolbarLayout(tier, BELOW)).toEqual({
        inline: ['interrupt'],
        overflow: ['model', 'effort', 'permission', 'mic', 'summarize', 'autoSummary'],
      })
    }
  })

  it('acima do piso o layout é idêntico ao sem largura', () => {
    for (const tier of TIERS) {
      expect(composerToolbarLayout(tier, 300)).toEqual(composerToolbarLayout(tier))
    }
  })

  it('nenhum controle some nem duplica abaixo do piso', () => {
    for (const tier of TIERS) {
      const { inline, overflow } = composerToolbarLayout(tier, BELOW)
      const all = [...inline, ...overflow]
      expect(all).toHaveLength(ALL.length)
      expect(new Set(all)).toEqual(new Set(ALL))
    }
  })
})
