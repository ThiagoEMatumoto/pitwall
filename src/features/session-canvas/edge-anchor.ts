import { Position } from '@xyflow/react'

// PURO: onde o fio encosta num nó. Em vez de sair sempre da direita e chegar pela
// esquerda (o que, com mãe e filha empilhadas na mesma coluna, passava o fio por
// cima dos cartões), sai do meio da borda voltada para o outro nó.
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Anchor {
  x: number
  y: number
  position: Position
}

export function borderAnchor(self: Rect, other: Rect): Anchor {
  const cx = self.x + self.w / 2
  const cy = self.y + self.h / 2
  const dx = other.x + other.w / 2 - cx
  const dy = other.y + other.h / 2 - cy
  // Compara as inclinações normalizadas pelo formato do nó: cartão é largo, então
  // um vizinho levemente abaixo e bem ao lado ainda sai pela lateral.
  if (Math.abs(dx) * self.h >= Math.abs(dy) * self.w) {
    return dx >= 0
      ? { x: self.x + self.w, y: cy, position: Position.Right }
      : { x: self.x, y: cy, position: Position.Left }
  }
  return dy >= 0
    ? { x: cx, y: self.y + self.h, position: Position.Bottom }
    : { x: cx, y: self.y, position: Position.Top }
}

export interface Pt {
  x: number
  y: number
}

// Calhas entre lanes de repo dentro do card da feature (GAP do layout = 16):
// vizinhas se a distância entre elas não passa disto.
const ADJACENT_MAX = 24
// Altura (do topo do cartão) por onde o fio entra e sai.
export const TITLE_BAND = 28
// Folga entre o pé do último cartão e o pé da raia (o PAD do layout é 12).
const LAST_IN_LANE_SLACK = 24

// Nada abaixo do cartão na raia: o fio pode descer direto até o canal do card.
function lastInLane(card: Rect, lane: Rect): boolean {
  return lane.y + lane.h - (card.y + card.h) <= LAST_IN_LANE_SLACK
}

// Rota ortogonal mãe→filha (ou bastão) entre cartões do MESMO card de feature:
// sai pela lateral do cartão, corre na calha entre as lanes e entra pela lateral
// do outro. Nunca atravessa um cartão: o cartão ocupa a largura da lane, então
// o trecho horizontal dentro da lane é só até a borda dela.
// - mesma lane: pela calha à esquerda dela;
// - lanes vizinhas: pela calha entre as duas;
// - lanes não vizinhas: desce a calha da origem até o canal no pé do card,
//   cruza por ele e sobe a calha do destino;
// - cartão que é o último da raia: pela borda inferior até o canal (leque).
export function gutterRoute(
  src: Rect,
  srcLane: Rect,
  tgt: Rect,
  tgtLane: Rect,
  channelY: number,
): Pt[] {
  // Na linha do título (o cartão aberto tem até 300px): mãe e filha alinhadas ao
  // topo ligam-se por um fio reto curto, não por um degrau no meio da saída.
  const sy = src.y + Math.min(src.h / 2, TITLE_BAND)
  const ty = tgt.y + Math.min(tgt.h / 2, TITLE_BAND)
  const sameLane = srcLane.x === tgtLane.x && srcLane.w === tgtLane.w
  if (sameLane) {
    const gx = srcLane.x - 6
    return [
      { x: src.x, y: sy },
      { x: gx, y: sy },
      { x: gx, y: ty },
      { x: tgt.x, y: ty },
    ]
  }
  const right = tgtLane.x >= srcLane.x + srcLane.w
  const sx = right ? src.x + src.w : src.x
  const tx = right ? tgt.x : tgt.x + tgt.w
  const srcEdge = right ? srcLane.x + srcLane.w : srcLane.x
  const tgtEdge = right ? tgtLane.x : tgtLane.x + tgtLane.w
  const g1 = srcEdge + (right ? 1 : -1) * 8
  const g2 = tgtEdge - (right ? 1 : -1) * 8
  // Leque pelo barramento do pé do card: o cartão que é o último da raia desce
  // (ou sobe) pelo meio da borda inferior até o canal. Mãe com 2 filhas vira um
  // tronco + uma descida por filha; pela lateral, o fio da 2ª filha passava sob
  // a 1ª e lia como a cadeia mãe→filha→neta.
  const srcDown = lastInLane(src, srcLane)
  const tgtUp = lastInLane(tgt, tgtLane)
  if (srcDown || tgtUp) {
    const head = srcDown
      ? [
          { x: src.x + src.w / 2, y: src.y + src.h },
          { x: src.x + src.w / 2, y: channelY },
        ]
      : [
          { x: sx, y: sy },
          { x: g1, y: sy },
          { x: g1, y: channelY },
        ]
    const tail = tgtUp
      ? [
          { x: tgt.x + tgt.w / 2, y: channelY },
          { x: tgt.x + tgt.w / 2, y: tgt.y + tgt.h },
        ]
      : [
          { x: g2, y: channelY },
          { x: g2, y: ty },
          { x: tx, y: ty },
        ]
    return [...head, ...tail]
  }
  if (Math.abs(tgtEdge - srcEdge) <= ADJACENT_MAX) {
    const gx = (srcEdge + tgtEdge) / 2
    return [
      { x: sx, y: sy },
      { x: gx, y: sy },
      { x: gx, y: ty },
      { x: tx, y: ty },
    ]
  }
  return [
    { x: sx, y: sy },
    { x: g1, y: sy },
    { x: g1, y: channelY },
    { x: g2, y: channelY },
    { x: g2, y: ty },
    { x: tx, y: ty },
  ]
}

// Polilinha com cantos arredondados (o "smoothstep" do xyflow, para N pontos).
export function roundedPath(points: Pt[], radius = 8): string {
  const pts = points.filter(
    (p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y,
  )
  if (pts.length === 0) return ''
  let d = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]
    const cur = pts[i]
    const next = pts[i + 1]
    const r = Math.min(
      radius,
      Math.hypot(cur.x - prev.x, cur.y - prev.y) / 2,
      Math.hypot(next.x - cur.x, next.y - cur.y) / 2,
    )
    const inX = cur.x - Math.sign(cur.x - prev.x) * r
    const inY = cur.y - Math.sign(cur.y - prev.y) * r
    const outX = cur.x + Math.sign(next.x - cur.x) * r
    const outY = cur.y + Math.sign(next.y - cur.y) * r
    d += ` L ${inX} ${inY} Q ${cur.x} ${cur.y} ${outX} ${outY}`
  }
  const last = pts[pts.length - 1]
  return `${d} L ${last.x} ${last.y}`
}

// Rótulo no meio do trecho mais longo (o que corre na calha/canal).
export function routeLabelPoint(points: Pt[]): Pt {
  let best = { len: -1, at: points[0] ?? { x: 0, y: 0 } }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len > best.len) best = { len, at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
  }
  return best.at
}
