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
}

export function toastStackPlacement(a: {
  dockWidth: number
  peek: PeekBox | null
  viewportWidth: number
  // Minimapa do mapa de sessões, quando visível (o obstáculo do canto).
  minimap?: PeekBox | null
  // Composer dock dos terminais visíveis.
  obstacles?: PeekBox[]
  viewportHeight?: number
}): ToastPlacement {
  if (!a.peek) {
    const right = a.dockWidth + TOAST_MARGIN
    const columnLeft = a.viewportWidth - right - TOAST_MIN_WIDTH
    const hits = [a.minimap, ...(a.obstacles ?? [])].filter(
      (b): b is PeekBox => !!b && b.left + b.width > columnLeft,
    )
    if (hits.length > 0 && a.viewportHeight) {
      const top = Math.min(...hits.map((b) => b.top))
      return { right, bottom: a.viewportHeight - top + TOAST_MARGIN, zIndex: BASE_Z }
    }
    return { right, bottom: TOAST_MARGIN, zIndex: BASE_Z }
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
