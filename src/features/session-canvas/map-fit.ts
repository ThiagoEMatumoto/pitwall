// PURO: o enquadramento inicial do mapa. Encaixar tudo com dados reais dava um
// zoom em que nada se lia; aqui o zoom nunca fica abaixo do mínimo legível. Se
// nem tudo couber nele, o que manda é o bbox de quem precisa de você (e, sem
// ninguém, o da sessão-alvo): ele entra inteiro na tela. Sempre ancorado no
// canto superior esquerdo — centralizado, sobrava uma faixa vazia no topo e a
// lane da esquerda nascia cortada.
import type { Rect } from './edge-anchor'

// "Legível" = o cartão vivo inteiro (saída ao vivo + prompt + aprovação) e o
// cabeçalho do card da feature lido sem compensação. Com 0.75 os títulos ficavam
// em ~10px efetivos; 0.9 é o piso pedido no uso diário.
export const MIN_READABLE_ZOOM = 0.9
export const MAX_FIT_ZOOM = 1
const PADDING = 24

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export function boundsOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const w = Math.max(...rects.map((r) => r.x + r.w)) - x
  const h = Math.max(...rects.map((r) => r.y + r.h)) - y
  return { x, y, w, h }
}

function zoomToFit(r: Rect, view: { w: number; h: number }): number {
  return Math.min((view.w - 2 * PADDING) / r.w, (view.h - 2 * PADDING) / r.h, MAX_FIT_ZOOM)
}

// Eixo a eixo: encosta no começo do conjunto; se a prioridade não couber a
// partir dali, desloca SÓ o necessário pra ela caber (a borda dela no fim da
// tela) — encostar o canto dela no começo jogava fora o contexto à esquerda.
// Prioridade maior que a tela: o canto dela no canto livre. Nunca centrada.
function anchored(all: Rect, priority: Rect | null, view: { w: number; h: number }, zoom: number) {
  const axis = (start: number, size: number, pStart: number, pSize: number) => {
    const aligned = PADDING - start * zoom
    const fitEnd = size - PADDING - (pStart + pSize) * zoom
    return Math.max(PADDING - pStart * zoom, Math.min(aligned, fitEnd))
  }
  return {
    x: axis(all.x, view.w, priority?.x ?? all.x, priority?.w ?? 0),
    y: axis(all.y, view.h, priority?.y ?? all.y, priority?.h ?? 0),
    zoom,
  }
}

export interface Insets {
  top?: number
  right?: number
  bottom?: number
  left?: number
}

// Insets: o que flutua por cima do mapa — a barra do topo (escopo/ações), os
// controles de zoom (esquerda), o minimapa (base) e o painel Equipe/Conversas
// aberto sobre o mapa (direita). Sem descontá-los, o
// cabeçalho da lane nascia embaixo da barra e os cartões da base embaixo do
// minimapa.
export function readableViewport(args: {
  visible: Rect | null
  // O que tem de aparecer inteiro: o bbox dos cartões que precisam de você, ou o
  // cartão da sessão-alvo (coordenadas absolutas).
  priority: Rect | null
  view: { w: number; h: number }
  insets?: Insets
}): Viewport | null {
  const { top = 0, right = 0, bottom = 0, left = 0 } = args.insets ?? {}
  const v = fitInside({
    ...args,
    view: { w: args.view.w - left - right, h: args.view.h - top - bottom },
  })
  return v ? { ...v, x: v.x + left, y: v.y + top } : null
}

// "100%": zoom 1 com o canto superior esquerdo do conteúdo encostado no canto
// livre do mapa. Centrado (o zoom dos controles), a lane da esquerda e o
// cabeçalho dela ficavam cortados.
export function actualSizeViewport(visible: Rect | null, insets: Insets = {}): Viewport | null {
  if (!visible) return null
  return {
    x: (insets.left ?? 0) + PADDING - visible.x,
    y: (insets.top ?? 0) + PADDING - visible.y,
    zoom: 1,
  }
}

function fitInside(args: {
  visible: Rect | null
  priority: Rect | null
  view: { w: number; h: number }
}): Viewport | null {
  const { visible, priority, view } = args
  if (!visible || view.w <= 0 || view.h <= 0) return null
  const zoom = Math.max(zoomToFit(visible, view), MIN_READABLE_ZOOM)
  return anchored(visible, priority, view, zoom)
}
