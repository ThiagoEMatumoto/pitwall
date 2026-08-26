import type { PanelTier, PanelTierThresholds } from './use-panel-tier'

// Limites próprios da barra do composer: ela carrega mais controle que o header,
// e nos thresholds default (420/220) um pane de 228px caía em 'mid' e estourava.
// Custo medido do conteúdo por tier: narrow ~137px, mid ~382px, wide ~554px.
// A folga cobre o rótulo dinâmico do Interromper ("Interrompendo…" é mais largo).
export const COMPOSER_TIERS: PanelTierThresholds = { wideMin: 580, narrowMax: 400 }

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

// Piso absoluto de largura. Medido no app: mesmo o layout narrow (3 ícones + o
// "⋯") ocupa 137px de conteúdo, e em 4 panes numa janela de 1000px cada pane fica
// com ~126px — o que era cortado ali era o próprio "⋯", sumindo com o acesso a
// todos os controles. Abaixo deste piso, sobra inline só Interromper + "⋯"
// (~34 + 21 + 8 de gap = 63px), que cabe em qualquer pane utilizável.
export const MIN_INLINE_ICONS = 140

export function composerToolbarLayout(
  tier: PanelTier,
  width?: number,
): {
  inline: ToolbarControl[]
  overflow: ToolbarControl[]
} {
  // O piso vence o tier: não adianta o tier prometer 3 ícones se eles não cabem.
  const belowFloor = width !== undefined && width < MIN_INLINE_ICONS
  const inline: ToolbarControl[] = belowFloor ? ['interrupt'] : INLINE[tier]
  return { inline, overflow: ORDER.filter((c) => !inline.includes(c)) }
}
