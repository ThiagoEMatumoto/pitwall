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

// Piso da prioridade (o card da feature, ou quem precisa de você): a 0.9 a
// feature cross-project de 3 lanes não cabia ao lado da Equipe e a 3ª raia
// nascia embaixo do dock. Até 0.6 o cabeçalho e o status ainda se leem.
export const PRIORITY_MIN_ZOOM = 0.6
// Com o painel da feature aberto: 0.5 cabia a 3ª raia mas dava ~11px físicos e
// sobrava meia tela vazia. 0.7 é o menor zoom em que o resumo se lê sem esforço;
// a feature que não couber nele fica com o canto no canto livre (as raias
// seguintes entram com pan, e a borda tem a sombra de "tem mais pra lá").
export const PANEL_MIN_ZOOM = 0.7
// No resumo (cartão estreito, título contra-escalado) o painel desce até aqui se
// for o que faz a feature caber inteira: a 0.7 a 3ª raia nascia sob o painel numa
// janela de 1400px. Acima de BLOCKS_BELOW (0.45), os cartões seguem com nome e status.
export const PANEL_COMPACT_MIN_ZOOM = 0.5
// Visão geral com muitas sessões: o piso cai para caber o conjunto inteiro —
// a 0.9 só 4 de 11 cartões apareciam e o resto não dava nem para saber onde estava.
export const OVERVIEW_MIN_ZOOM = 0.45
export const OVERVIEW_MIN_CARDS = 7

// Zoom em que a visão geral ainda se lê (o resumo dos cartões, a fonte
// compensada do cabeçalho). O layout quebra os cards em linhas para o conjunto
// caber nele em vez de virar uma faixa só a 0.45.
export const WRAP_ZOOM = 0.7
// Controles de zoom à esquerda + o respiro do enquadrar dos dois lados.
const WRAP_CHROME_PX = 64 + 2 * PADDING
const WRAP_STEP = 50

/** Largura (px do fluxo) da linha de cards para a área do mapa; degraus de 50px. */
export function wrapRowWidth(containerW: number): number | undefined {
  const free = containerW - WRAP_CHROME_PX
  if (free <= 0) return undefined
  return Math.floor(free / WRAP_ZOOM / WRAP_STEP) * WRAP_STEP
}

export interface FitPlan {
  viewport: Viewport
  // O dock (Equipe/Conversas sobre o mapa) tem de recolher: a prioridade não
  // cabe no piso com ele aberto e cabe melhor sem ele.
  collapseDock: boolean
  // A prioridade cabe inteira no zoom escolhido.
  priorityFits: boolean
}

function freeView(view: { w: number; h: number }, i: Insets) {
  return {
    w: view.w - (i.left ?? 0) - (i.right ?? 0),
    h: view.h - (i.top ?? 0) - (i.bottom ?? 0),
  }
}

// Sobra de altura a partir da qual o enquadrar centraliza na vertical: com poucas
// sessões, encostado no topo, 55% de baixo do mapa ficavam vazios.
const CENTER_SPARE_SHARE = 0.3

// Só centraliza com poucas sessões no teto de 100% (sobra largura e altura).
// Abaixo dele quem manda é a largura (a feature de 3 raias) ou o teto do resumo
// (0.72): centralizado ficavam ~385px vazios em cima e embaixo, e o enquadrar
// parecia solto. Encosta no topo.
function centeredWhenShort(visible: Rect, free: { w: number; h: number }, v: Viewport): Viewport {
  const widthLimited = v.zoom >= (free.w - 2 * PADDING) / visible.w - 1e-6
  if (widthLimited || v.zoom < MAX_FIT_ZOOM - 1e-6) return v
  const spare = free.h - visible.h * v.zoom
  if (spare <= CENTER_SPARE_SHARE * free.h) return v
  return { ...v, y: spare / 2 - visible.y * v.zoom }
}

function planWith(
  visible: Rect,
  priority: Rect | null,
  view: { w: number; h: number },
  insets: Insets,
  cardCount: number,
  needsYou: boolean,
  maxZoom = MAX_FIT_ZOOM,
  priorityFloor = PRIORITY_MIN_ZOOM,
  alignTop = false,
): { viewport: Viewport; priorityFits: boolean; overviewFits: boolean } | null {
  const free = freeView(view, insets)
  if (free.w <= 0 || free.h <= 0) return null
  const all = zoomToFit(visible, free)
  // Alguém precisa de você: o cartão dele tem de estar inteiro E acionável
  // (Aprovar/Negar só existem acima de BRIEF_BELOW) — nada de visão geral.
  const overview = !needsYou && cardCount >= OVERVIEW_MIN_CARDS
  const floor = overview ? OVERVIEW_MIN_ZOOM : MIN_READABLE_ZOOM
  let zoom = Math.min(Math.max(all, floor), maxZoom)
  let priorityFits = true
  if (priority) {
    const p = zoomToFit(priority, free)
    if (p < zoom && !needsYou) zoom = Math.max(p, Math.min(priorityFloor, zoom))
    priorityFits = p >= zoom
  }
  const a = anchored(visible, priority, free, zoom)
  const v = alignTop ? a : centeredWhenShort(visible, free, a)
  return {
    viewport: { ...v, x: v.x + (insets.left ?? 0), y: v.y + (insets.top ?? 0) },
    priorityFits,
    // Visão geral que não cabe no piso: o resto fica fora da vista.
    overviewFits: !overview || all >= OVERVIEW_MIN_ZOOM,
  }
}

/**
 * O "Enquadrar": tudo no maior zoom até 100% e nunca abaixo do piso (0.9, ou
 * 0.45 com 7+ cartões); se a prioridade não couber nele, desce até 0.6 por ela.
 * Ainda sem caber (a prioridade, ou a visão geral com 7+) e com o dock aberto
 * (`dockInset` = o quanto dele está em `insets.right`), recolhe o dock e
 * enquadra sem ele.
 */
export function planFit(args: {
  visible: Rect | null
  priority: Rect | null
  view: { w: number; h: number }
  insets?: Insets
  dockInset?: number
  cardCount: number
  // A prioridade é quem precisa de você (não o card da feature mais recente).
  needsYou?: boolean
  // Teto do zoom (2º passe no resumo: passar de BRIEF_BELOW reabriria os cartões).
  maxZoom?: number
  // Piso da prioridade (padrão PRIORITY_MIN_ZOOM). O painel da feature usa
  // PANEL_MIN_ZOOM: o card dela tem de caber inteiro ao lado dele.
  priorityFloor?: number
  // Encosta no topo mesmo sobrando altura (painel da feature aberto: centralizado,
  // sobravam ~400px vazios acima do card que o painel descreve).
  alignTop?: boolean
}): FitPlan | null {
  const { visible, priority, view, cardCount } = args
  const needsYou = args.needsYou ?? false
  if (!visible) return null
  const insets = args.insets ?? {}
  const withDock = planWith(
    visible,
    priority,
    view,
    insets,
    cardCount,
    needsYou,
    args.maxZoom,
    args.priorityFloor,
    args.alignTop,
  )
  if (!withDock) return null
  const dock = args.dockInset ?? 0
  const fits = withDock.priorityFits && withDock.overviewFits
  // Visão geral (7+) abaixo do zoom de leitura com o dock aberto: sem ele ela
  // pode chegar lá — recolhe se o zoom melhorar.
  const overviewLow =
    !needsYou && cardCount >= OVERVIEW_MIN_CARDS && withDock.viewport.zoom < WRAP_ZOOM
  const keep = {
    viewport: withDock.viewport,
    collapseDock: false,
    priorityFits: withDock.priorityFits,
  }
  if ((fits && !overviewLow) || dock <= 0) return keep
  const right = Math.max(0, (insets.right ?? 0) - dock)
  const without = planWith(
    visible,
    priority,
    view,
    { ...insets, right },
    cardCount,
    needsYou,
    args.maxZoom,
    args.priorityFloor,
    args.alignTop,
  )
  if (!without) return keep
  if (fits && without.viewport.zoom <= withDock.viewport.zoom) return keep
  return { viewport: without.viewport, collapseDock: true, priorityFits: without.priorityFits }
}

// Fora = mais de 30% do cartão fora da área livre. Com "metade", o cartão meio
// coberto pelo dock (o nome cortado, a raia sem "+ Nova sessão") não contava.
const OFFSCREEN_HIDDEN_SHARE = 0.3

export type MapSide = 'left' | 'right' | 'top' | 'bottom'

function overlap(a: { l: number; t: number; r: number; b: number }, o: Rect): number {
  const w = Math.min(a.r, o.x + o.w) - Math.max(a.l, o.x)
  const h = Math.min(a.b, o.y + o.h) - Math.max(a.t, o.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Cartões (rects absolutos) fora da área livre, por lado, e o lado em que há mais deles.
 * `obstacles` (px de tela, relativos ao contêiner): o que cobre só um canto, como o
 * minimapa. Como inset da base inteira, o cartão à esquerda do minimapa, na mesma
 * altura dele e todo à vista, contava como "fora da vista".
 */
export function offscreenCards(
  cards: Rect[],
  viewport: Viewport,
  view: { w: number; h: number },
  insets: Insets = {},
  obstacles: Rect[] = [],
): {
  count: number
  side: MapSide | null
  sides: Record<MapSide, number>
  // Índices (em `cards`) dos cartões fora, com o lado de cada um.
  hidden: Array<{ index: number; side: MapSide }>
} {
  const box = {
    l: insets.left ?? 0,
    t: insets.top ?? 0,
    r: view.w - (insets.right ?? 0),
    b: view.h - (insets.bottom ?? 0),
  }
  const sides: Record<MapSide, number> = { left: 0, right: 0, top: 0, bottom: 0 }
  const hidden: Array<{ index: number; side: MapSide }> = []
  let count = 0
  for (const [index, c] of cards.entries()) {
    const l = c.x * viewport.zoom + viewport.x
    const t = c.y * viewport.zoom + viewport.y
    const r = l + c.w * viewport.zoom
    const b = t + c.h * viewport.zoom
    const inside = {
      l: Math.max(l, box.l),
      t: Math.max(t, box.t),
      r: Math.min(r, box.r),
      b: Math.min(b, box.b),
    }
    const vw = Math.max(0, inside.r - inside.l)
    const vh = Math.max(0, inside.b - inside.t)
    const covered = vw && vh ? obstacles.reduce((sum, o) => sum + overlap(inside, o), 0) : 0
    if (vw * vh - covered >= (1 - OFFSCREEN_HIDDEN_SHARE) * (r - l) * (b - t)) continue
    count++
    // O lado é a borda que mais o corta (o meio do cartão pode estar dentro).
    const cut: Record<MapSide, number> = {
      left: box.l - l,
      right: r - box.r,
      top: box.t - t,
      bottom: b - box.b,
    }
    const worst = (Object.keys(cut) as MapSide[]).reduce((a, k) => (cut[k] > cut[a] ? k : a))
    sides[worst]++
    hidden.push({ index, side: worst })
  }
  if (count === 0) return { count, side: null, sides, hidden }
  const side = (Object.keys(sides) as MapSide[]).reduce((a, k) => (sides[k] > sides[a] ? k : a))
  return { count, side, sides, hidden }
}

type Box = { l: number; t: number; r: number; b: number }

const PILL_MARGIN = 12
// Folga em volta da borda de um frame: o pill que a cruza (ou encosta nela) lê
// como parte do card.
const PILL_BORDER_SLOP = 8
const PILL_SPOTS = [0.5, 0.3, 0.7, 0.15, 0.85]

function hits(a: Box, b: Box): boolean {
  return a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const PILL_OBSTACLE_SLOP = 4
const PILL_SCAN_STEP = 4

// O 1º valor em [lo, hi] em que `ok` vale, em ordem de distância a `want`.
function scanFree(want: number, lo: number, hi: number, ok: (v: number) => boolean) {
  if (ok(want)) return want
  for (let d = PILL_SCAN_STEP; want - d >= lo || want + d <= hi; d += PILL_SCAN_STEP) {
    if (want - d >= lo && ok(want - d)) return want - d
    if (want + d <= hi && ok(want + d)) return want + d
  }
  return null
}

/**
 * Onde fica o pill "N fora da vista": colado no lado em que eles estão, dentro da
 * área livre (`box`, px do contêiner). Com `target` (o cartão oculto mais próximo,
 * px do contêiner), na mesma faixa dele, presa à área livre: longe dele, o pill
 * flutuava no canvas vazio e não se ligava ao cartão cortado — cruzar um frame aí
 * vale (o fundo dele é opaco). Sem alvo, o 1º ponto ao longo da borda em que ele
 * não cruza a borda de nenhum frame (`frames`).
 */
export function pillSpot(
  side: MapSide,
  box: Box,
  frames: Rect[],
  size: { w: number; h: number },
  target?: Rect | null,
  // Px do contêiner: os cartões À VISTA e os cabeçalhos dos frames. Na faixa do
  // alvo o pill cobria o nome do cartão vizinho (print 07: "otavio-pa… c1-checkout").
  obstacles: Rect[] = [],
): { x: number; y: number } {
  const vertical = side === 'left' || side === 'right'
  if (target) {
    const covers = (p: { x: number; y: number }) => {
      const pill = { l: p.x, t: p.y, r: p.x + size.w, b: p.y + size.h }
      const s = PILL_OBSTACLE_SLOP
      return obstacles.some((o) =>
        hits(pill, { l: o.x - s, t: o.y - s, r: o.x + o.w + s, b: o.y + o.h + s }),
      )
    }
    // A faixa do alvo primeiro; ocupada, o ponto livre mais perto dela ao longo
    // da mesma borda (a faixa vazia acima/abaixo da lane). Nada livre: a faixa.
    if (vertical) {
      const x = side === 'right' ? box.r - PILL_MARGIN - size.w : box.l + PILL_MARGIN
      const lo = box.t + PILL_MARGIN
      const hi = box.b - PILL_MARGIN - size.h
      const want = clamp(target.y + target.h / 2 - size.h / 2, lo, hi)
      const free = scanFree(want, lo, hi, (y) => !covers({ x, y }))
      return { x, y: free ?? want }
    }
    const y = side === 'top' ? box.t + PILL_MARGIN : box.b - PILL_MARGIN - size.h
    const lo = box.l + PILL_MARGIN
    const hi = box.r - PILL_MARGIN - size.w
    const want = clamp(target.x + target.w / 2 - size.w / 2, lo, hi)
    const free = scanFree(want, lo, hi, (x) => !covers({ x, y }))
    return { x: free ?? want, y }
  }
  const spots = PILL_SPOTS.map((f) => {
    if (vertical) {
      const x = side === 'right' ? box.r - PILL_MARGIN - size.w : box.l + PILL_MARGIN
      return { x, y: box.t + f * (box.b - box.t) - size.h / 2 }
    }
    const y = side === 'top' ? box.t + PILL_MARGIN : box.b - PILL_MARGIN - size.h
    return { x: box.l + f * (box.r - box.l) - size.w / 2, y }
  })
  const crossesBorder = (p: { x: number; y: number }) => {
    const pill = { l: p.x, t: p.y, r: p.x + size.w, b: p.y + size.h }
    return frames.some((f) => {
      const s = PILL_BORDER_SLOP
      const outer = { l: f.x - s, t: f.y - s, r: f.x + f.w + s, b: f.y + f.h + s }
      const inner = { l: f.x + s, t: f.y + s, r: f.x + f.w - s, b: f.y + f.h - s }
      const inside =
        pill.l >= inner.l && pill.r <= inner.r && pill.t >= inner.t && pill.b <= inner.b
      return hits(pill, outer) && !inside
    })
  }
  return spots.find((p) => !crossesBorder(p)) ?? spots[0]
}

export interface OverflowEdges {
  top: boolean
  right: boolean
  bottom: boolean
  left: boolean
}

// Quais bordas da área LIVRE do mapa (descontados barra, controles e painel à
// direita) têm conteúdo além delas. É o que acende a sombra de "tem mais pra lá".
// Tolerância de alguns px: o enquadrar encosta o conteúdo no PADDING e um
// arredondamento não pode acender a dica.
export function overflowEdges(
  content: Rect | null,
  viewport: Viewport,
  view: { w: number; h: number },
  insets: Insets = {},
): OverflowEdges {
  const none = { top: false, right: false, bottom: false, left: false }
  if (!content) return none
  const tol = 4
  const left = content.x * viewport.zoom + viewport.x
  const top = content.y * viewport.zoom + viewport.y
  const right = left + content.w * viewport.zoom
  const bottom = top + content.h * viewport.zoom
  return {
    left: left < (insets.left ?? 0) - tol,
    top: top < (insets.top ?? 0) - tol,
    right: right > view.w - (insets.right ?? 0) + tol,
    bottom: bottom > view.h - (insets.bottom ?? 0) + tol,
  }
}

const NOTE_SLOT_GAP = 24

// Onde nasce a nota solta: ao lado (direita) do que está selecionado — ou do
// card da feature —, senão logo abaixo dele; o 1º lugar que não cobre nada.
// Null: nenhum livre, fica o padrão do layout. Antes ela caía em x=0 acima das
// lanes, quase sempre fora da vista.
export function noteSlot(
  anchor: Rect,
  obstacles: Rect[],
  size: { w: number; h: number },
): { x: number; y: number } | null {
  const candidates = [
    { x: anchor.x + anchor.w + NOTE_SLOT_GAP, y: anchor.y },
    { x: anchor.x, y: anchor.y + anchor.h + NOTE_SLOT_GAP },
    { x: anchor.x - size.w - NOTE_SLOT_GAP, y: anchor.y },
  ]
  const hits = (p: { x: number; y: number }) =>
    obstacles.some(
      (o) => p.x < o.x + o.w && p.x + size.w > o.x && p.y < o.y + o.h && p.y + size.h > o.y,
    )
  return candidates.find((p) => !hits(p)) ?? null
}

const MINIMAP_W = 200
const MINIMAP_MAX_H = 140
const MINIMAP_MIN_H = 60

/** Tamanho do minimapa na proporção do conteúdo: com a altura fixa sobrava ~85% vazio. */
export function minimapSize(content: Rect | null): { w: number; h: number } {
  if (!content || content.w <= 0) return { w: MINIMAP_W, h: MINIMAP_MAX_H }
  const h = Math.round((MINIMAP_W * content.h) / content.w)
  return { w: MINIMAP_W, h: Math.min(MINIMAP_MAX_H, Math.max(MINIMAP_MIN_H, h)) }
}

// O conteúdo inteiro (coordenadas do fluxo) está dentro da tela? Com tudo à
// vista o minimapa só ocupa o canto com um retângulo que cobre tudo: some, e
// volta quando algo sai da vista.
export function contentInView(
  bounds: Rect | null,
  transform: readonly [number, number, number],
  size: { width: number; height: number },
): boolean {
  if (!bounds || size.width <= 0 || size.height <= 0) return true
  const [tx, ty, z] = transform
  const left = bounds.x * z + tx
  const top = bounds.y * z + ty
  const SLACK = 1
  return (
    left >= -SLACK &&
    top >= -SLACK &&
    left + bounds.w * z <= size.width + SLACK &&
    top + bounds.h * z <= size.height + SLACK
  )
}
