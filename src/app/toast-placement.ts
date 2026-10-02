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
// Largura real da coluna (max-w-xs do ToastFrame) e altura de um toast com título,
// 2 linhas de corpo e o botão de ação: é o que precisa caber fora dos obstáculos.
export const TOAST_COLUMN_W = 320
export const TOAST_EST_H = 96
const STACK_GAP = 8
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
    const columnRight = a.viewportWidth - right
    const hits = [a.minimap, ...(a.obstacles ?? [])].filter(
      (b): b is PeekBox =>
        !!b && b.left + b.width > columnRight - TOAST_COLUMN_W && b.left < columnRight,
    )
    if (hits.length === 0 || !a.viewportHeight)
      return { right, bottom: TOAST_MARGIN, zIndex: BASE_Z, ...cap }
    const need = (a.onMap ? MAP_MAX_VISIBLE : 1) * (TOAST_EST_H + STACK_GAP)
    const slot = freeSlotBottom(hits, a.viewportHeight, need)
    if (slot !== null) return { right, bottom: a.viewportHeight - slot, zIndex: BASE_Z, ...cap }
    return besideObstacles(hits, right, a.viewportWidth, a.viewportHeight, cap)
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
  // Sem faixa embaixo: escondida. A faixa de cima é a barra de título, e um "+N"
  // solto ali ficava sobre minimizar/maximizar/fechar e não dizia de onde vinha.
  // Janela pequena: a modal ocupa tudo. Os toasts seguem a vida (somem sozinhos)
  // sem aparecer — a modal já mostra a sessão que importa agora.
  return { right: TOAST_MARGIN, top: 4, zIndex: ABOVE_PEEK_Z, maxVisible: 0, hidden: true }
}

// A coluna da pilha cruza obstáculos (minimapa, composer, cartão da mãe, coluna
// fixada): o vão livre mais baixo onde a pilha inteira cabe. Os candidatos são o
// pé da tela e o topo de cada obstáculo — todo vão termina num deles. Devolve o y
// da base da pilha, ou null se nenhum vão comporta a altura pedida.
function freeSlotBottom(hits: PeekBox[], viewportHeight: number, need: number): number | null {
  const anchors = [viewportHeight, ...hits.map((b) => b.top)]
    .map((y) => y - TOAST_MARGIN)
    .sort((x, y) => y - x)
  for (const base of anchors) {
    const top = base - need
    if (top < TOAST_MARGIN) continue
    const clear = hits.every(
      (b) => b.top - TOAST_MARGIN >= base || b.top + b.height + TOAST_MARGIN <= top,
    )
    if (clear) return base
  }
  return null
}

// Sem vão na vertical (o cartão da mãe ou a coluna fixada tomam a coluna toda): à
// direita deles, numa coluna mais estreita, ou à esquerda. Sem nenhum dos dois, o
// comportamento antigo (acima do mais alto) com um toast só.
function besideObstacles(
  hits: PeekBox[],
  right: number,
  viewportWidth: number,
  viewportHeight: number,
  cap: { maxVisible?: number },
): ToastPlacement {
  const columnRight = viewportWidth - right
  const hitsRight = Math.max(...hits.map((b) => b.left + b.width))
  const room = columnRight - hitsRight - TOAST_MARGIN
  if (room >= TOAST_MIN_WIDTH)
    return { right, bottom: TOAST_MARGIN, zIndex: BASE_Z, maxWidth: room, ...cap }
  const hitsLeft = Math.min(...hits.map((b) => b.left))
  if (hitsLeft - TOAST_MARGIN - TOAST_COLUMN_W >= TOAST_MARGIN)
    return {
      right: viewportWidth - hitsLeft + TOAST_MARGIN,
      bottom: TOAST_MARGIN,
      zIndex: BASE_Z,
      ...cap,
    }
  const top = Math.min(...hits.map((b) => b.top))
  return { right, bottom: viewportHeight - top + TOAST_MARGIN, zIndex: BASE_Z, maxVisible: 1 }
}
