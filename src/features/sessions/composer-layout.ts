import type { PanelTier } from './use-panel-tier'

// Controles da barra do composer, na ordem canônica de exibição.
export type ToolbarControl =
  'model' | 'effort' | 'permission' | 'interrupt' | 'mic' | 'summarize' | 'autoSummary'

const ORDER: ToolbarControl[] = [
  'model',
  'effort',
  'permission',
  'interrupt',
  'mic',
  'summarize',
  'autoSummary',
]

// O que sobrevive inline em cada tier. 'model', 'interrupt' e 'mic' nunca caem no
// overflow: são o que o usuário busca no meio de uma sessão, e esconder isso atrás
// de um "⋯" custa um clique justamente na hora errada. 'effort'/'permission' só
// somem no narrow, onde não há largura pra mais que o essencial.
const INLINE: Record<PanelTier, ToolbarControl[]> = {
  wide: ORDER,
  mid: ['model', 'effort', 'permission', 'interrupt', 'mic'],
  narrow: ['model', 'interrupt', 'mic'],
}

export function composerToolbarLayout(tier: PanelTier): {
  inline: ToolbarControl[]
  overflow: ToolbarControl[]
} {
  const inline = INLINE[tier]
  return { inline, overflow: ORDER.filter((c) => !inline.includes(c)) }
}
