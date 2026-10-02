// PURO: zoom-to-card (tecla F). Enquadra o cartão selecionado no maior zoom em
// que ele cabe inteiro, sem passar do tamanho real (min(fit, 1)): é o jeito de
// ler uma filha a 1.0 sem abrir a modal. O viewport de antes fica guardado e o
// segundo F (ou Esc) volta exatamente a ele.
import type { Rect } from './edge-anchor'
import type { Insets, Viewport } from './map-fit'

const PADDING = 24

export function cardZoomViewport(
  card: Rect,
  view: { w: number; h: number },
  insets: Insets = {},
): Viewport {
  const left = insets.left ?? 0
  const top = insets.top ?? 0
  const freeW = Math.max(1, view.w - left - (insets.right ?? 0))
  const freeH = Math.max(1, view.h - top - (insets.bottom ?? 0))
  const fit = Math.min((freeW - 2 * PADDING) / card.w, (freeH - 2 * PADDING) / card.h)
  const zoom = Math.min(1, fit > 0 ? fit : 1)
  return {
    x: left + freeW / 2 - (card.x + card.w / 2) * zoom,
    y: top + freeH / 2 - (card.y + card.h / 2) * zoom,
    zoom,
  }
}

// saved: o viewport guardado pelo 1º F (null = não está enquadrado).
// target: o enquadre do cartão selecionado (null = nenhum cartão).
export function toggleCardZoom(
  saved: Viewport | null,
  current: Viewport,
  target: Viewport | null,
): { apply: Viewport | null; saved: Viewport | null } {
  if (saved) return { apply: saved, saved: null }
  if (!target) return { apply: null, saved: null }
  return { apply: target, saved: current }
}
