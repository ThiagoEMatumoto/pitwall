// Onde o HUD da fila de atenção fica na vertical (px do topo da janela). Puro —
// o componente mede os vizinhos e passa aqui.
//
// Sem peek: logo abaixo da faixa de abas do dockview (ou da titlebar, fora da
// área de projetos), sem cobrir o nome da aba. Com o peek aberto: no respiro
// acima do painel, e se não couber, no de baixo — nunca encostado nele.

export const HUD_GAP = 8
const MIN_MARGIN = 4

export interface HudAnchors {
  titlebarBottom: number
  // Base da faixa de abas mais alta visível; null fora da área de projetos.
  tabsBottom: number | null
  peek: { top: number; bottom: number } | null
  viewportHeight: number
  hudHeight: number
}

export function hudTop(a: HudAnchors): number {
  if (a.peek) {
    const above = a.peek.top - a.hudHeight - MIN_MARGIN
    if (above >= MIN_MARGIN) return above
    const below = a.peek.bottom + MIN_MARGIN
    if (below + a.hudHeight <= a.viewportHeight - MIN_MARGIN) return below
  }
  return Math.max(a.titlebarBottom, a.tabsBottom ?? 0) + HUD_GAP
}
