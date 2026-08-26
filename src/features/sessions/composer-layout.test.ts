import { describe, expect, it } from 'vitest'
import { composerToolbarLayout, type ToolbarControl } from './composer-layout'
import type { PanelTier } from './use-panel-tier'

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
