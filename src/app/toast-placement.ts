// Onde a pilha de toasts fica. Puro — o AppShell mede o painel do peek e passa aqui.
//
// Sem peek: canto inferior direito, recuada pela largura do Crew Dock. Com o
// peek aberto (overlay por cima do dock): no respiro à direita do painel, acima
// do backdrop; se não couber, no topo do transcript do peek — nunca em cima do
// input de resposta, que é onde o usuário está digitando.
//
// Sem peek, o canto inferior direito tem dono: o minimapa (mapa de sessões) ou o
// composer dock do terminal (vista Terminais). A pilha sobe pra cima do mais alto
// deles que encosta na coluna dela, em vez de cobrir onde o usuário digita.

export const TOAST_MARGIN = 16
export const TOAST_MIN_WIDTH = 160
// Altura do cabeçalho do peek (nome, status, abas Chat/Terminal): a pilha de
// fallback começa abaixo dele pra não cobrir o botão de fechar.
export const PEEK_HEADER_HEIGHT = 120
// Acima do z-[1000] do backdrop do peek (mesmo do Dialog).
const ABOVE_PEEK_Z = 1001
const BASE_Z = 50

export interface PeekBox {
  left: number
  top: number
  width: number
  height: number
}

export interface ToastPlacement {
  right: number
  top?: number
  bottom?: number
  zIndex: number
  maxWidth?: number
  // Quantos toasts aparecem; o resto colapsa num "+N" (e segue sumindo sozinho).
  // Ausente = todos. 0 = só o "+N" (não há espaço fora da modal).
  maxVisible?: number
  // Nem o "+N" cabe fora da modal: a pilha fica invisível até ela fechar.
  hidden?: boolean
}

// No mapa a pilha divide a tela com cartões e painéis: no máximo 2 por vez.
export const MAP_MAX_VISIBLE = 2
// Altura do "+N" sozinho, quando é só ele que cabe no respiro da modal.
const COLLAPSED_H = 28

export function toastStackPlacement(a: {
  dockWidth: number
  peek: PeekBox | null
  viewportWidth: number
  // Minimapa do mapa de sessões, quando visível (o obstáculo do canto).
  minimap?: PeekBox | null
  // Composer dock dos terminais visíveis.
  obstacles?: PeekBox[]
  viewportHeight?: number
  // A modal grande do terminal do mapa (lift): a pilha NUNCA entra nela.
  lift?: boolean
  // Mapa visível: teto de toasts (MAP_MAX_VISIBLE).
  onMap?: boolean
  // Painel lateral encostado à direita (painel da feature): a pilha sai da frente dele.
  rightPanel?: PeekBox | null
}): ToastPlacement {
  const cap = a.onMap ? { maxVisible: MAP_MAX_VISIBLE } : {}
  if (a.peek && a.lift) {
    const lp = liftPlacement(a.peek, a.viewportWidth, a.viewportHeight)
    return lp.maxVisible === undefined ? { ...lp, ...cap } : lp
  }
  if (!a.peek) {
    const panelInset = a.rightPanel ? Math.max(0, a.viewportWidth - a.rightPanel.left) : 0
    const right = Math.max(a.dockWidth, panelInset) + TOAST_MARGIN
    const columnLeft = a.viewportWidth - right - TOAST_MIN_WIDTH
    const hits = [a.minimap, ...(a.obstacles ?? [])].filter(
      (b): b is PeekBox => !!b && b.left + b.width > columnLeft,
    )
    if (hits.length > 0 && a.viewportHeight) {
      const top = Math.min(...hits.map((b) => b.top))
      return { right, bottom: a.viewportHeight - top + TOAST_MARGIN, zIndex: BASE_Z, ...cap }
    }
    return { right, bottom: TOAST_MARGIN, zIndex: BASE_Z, ...cap }
  }
  const sideGap = a.viewportWidth - (a.peek.left + a.peek.width)
  if (sideGap >= TOAST_MIN_WIDTH + 2 * TOAST_MARGIN) {
    return {
      right: TOAST_MARGIN,
      bottom: TOAST_MARGIN,
      zIndex: ABOVE_PEEK_Z,
      maxWidth: sideGap - 2 * TOAST_MARGIN,
    }
  }
  return {
    right: sideGap + TOAST_MARGIN,
    top: a.peek.top + PEEK_HEADER_HEIGHT,
    zIndex: ABOVE_PEEK_Z,
  }
}

// Com a modal do terminal aberta: no respiro lateral se couber a coluna; senão
// na faixa acima (ou abaixo) da modal, só o "+N"; sem faixa nenhuma, escondida.
function liftPlacement(peek: PeekBox, viewportWidth: number, viewportHeight?: number): ToastPlacement {
  const sideGap = viewportWidth - (peek.left + peek.width)
  if (sideGap >= TOAST_MIN_WIDTH + 2 * TOAST_MARGIN) {
    return {
      right: TOAST_MARGIN,
      bottom: TOAST_MARGIN,
      zIndex: ABOVE_PEEK_Z,
      maxWidth: sideGap - 2 * TOAST_MARGIN,
    }
  }
  // A faixa de baixo primeiro: a de cima é a barra de título, e no canto direito
  // dela ficam fechar/maximizar — o "+N" ali cobria o botão de fechar a janela.
  const strip = COLLAPSED_H + 8
  const below = viewportHeight !== undefined ? viewportHeight - (peek.top + peek.height) : 0
  if (below >= strip) {
    return { right: TOAST_MARGIN, bottom: Math.max(4, (below - COLLAPSED_H) / 2), zIndex: ABOVE_PEEK_Z, maxVisible: 0 }
  }
  if (peek.top >= strip) {
    return { right: TOAST_MARGIN, top: Math.max(4, (peek.top - COLLAPSED_H) / 2), zIndex: ABOVE_PEEK_Z, maxVisible: 0 }
  }
  // Janela pequena: a modal ocupa tudo. Os toasts seguem a vida (somem sozinhos)
  // sem aparecer — a modal já mostra a sessão que importa agora.
  return { right: TOAST_MARGIN, top: 4, zIndex: ABOVE_PEEK_Z, maxVisible: 0, hidden: true }
}
