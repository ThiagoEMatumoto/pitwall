import { describe, expect, it } from 'vitest'
import { gutterRoute, roundedPath, routeLabelPoint, type Pt, type Rect } from './edge-anchor'

const lane = (x: number): Rect => ({ x, y: 58, w: 424, h: 600 })
const card = (laneX: number, y: number): Rect => ({ x: laneX + 12, y, w: 400, h: 180 })

// Nenhum trecho passa por dentro de um cartão (bordas tocadas valem).
function crosses(points: Pt[], r: Rect): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const minX = Math.min(a.x, b.x)
    const maxX = Math.max(a.x, b.x)
    const minY = Math.min(a.y, b.y)
    const maxY = Math.max(a.y, b.y)
    if (maxX > r.x && minX < r.x + r.w && maxY > r.y && minY < r.y + r.h) return true
  }
  return false
}

describe('gutterRoute — fio pelas calhas', () => {
  it('lanes vizinhas: sai pela direita, corre na calha entre elas, entra pela esquerda', () => {
    const src = card(12, 88)
    const tgt = card(452, 300)
    const pts = gutterRoute(src, lane(12), tgt, lane(452), 900)
    // Entra e sai na linha do título (28px do topo), não no meio do cartão aberto.
    expect(pts[0]).toEqual({ x: src.x + src.w, y: src.y + 28 })
    expect(pts[1].x).toBe(444)
    expect(pts.at(-1)).toEqual({ x: tgt.x, y: tgt.y + 28 })
    expect(pts.every((p, i) => i === 0 || p.x === pts[i - 1].x || p.y === pts[i - 1].y)).toBe(true)
  })

  it('lanes não vizinhas: passa pelo canal do pé do card, sem cruzar a lane do meio', () => {
    const src = card(12, 88)
    const tgt = card(892, 88)
    const middle = [card(452, 88), card(452, 292), card(452, 496)]
    const pts = gutterRoute(src, lane(12), tgt, lane(892), 680)
    expect(pts.some((p) => p.y === 680)).toBe(true)
    for (const m of middle) expect(crosses(pts, m)).toBe(false)
  })

  it('destino à esquerda: sai pela esquerda e entra pela direita', () => {
    const src = card(452, 88)
    const tgt = card(12, 88)
    const pts = gutterRoute(src, lane(452), tgt, lane(12), 900)
    expect(pts[0].x).toBe(src.x)
    expect(pts.at(-1)!.x).toBe(tgt.x + tgt.w)
  })

  it('mesma lane: pela calha à esquerda, sem passar pelo cartão do meio', () => {
    const src = card(12, 88)
    const between = card(12, 292)
    const tgt = card(12, 496)
    const pts = gutterRoute(src, lane(12), tgt, lane(12), 900)
    expect(pts[1].x).toBeLessThan(lane(12).x)
    expect(crosses(pts, between)).toBe(false)
  })
})

describe('roundedPath / routeLabelPoint', () => {
  it('arredonda os cantos e termina no último ponto', () => {
    const d = roundedPath([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 100 },
    ])
    expect(d.startsWith('M 0 0')).toBe(true)
    expect(d).toContain('Q 50 0')
    expect(d.endsWith('L 50 100')).toBe(true)
  })
  it('rótulo no meio do trecho mais longo', () => {
    expect(
      routeLabelPoint([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 200 },
      ]),
    ).toEqual({ x: 10, y: 100 })
  })
})

describe('gutterRoute — cartões alinhados ao topo', () => {
  it('mãe e filha em raias vizinhas, mesma altura: fio reto na linha do título', () => {
    const src = { x: 24, y: 88, w: 400, h: 200 }
    const tgt = { x: 464, y: 88, w: 400, h: 64 }
    const pts = gutterRoute(src, lane(12), tgt, lane(452), 900)
    expect(new Set(pts.map((p) => p.y))).toEqual(new Set([116]))
  })
})

describe('gutterRoute — leque pelo barramento do pé do card', () => {
  // Raias do resumo: um cartão só, a raia termina 12px abaixo dele.
  const shortLane = (x: number): Rect => ({ x, y: 58, w: 424, h: 30 + 64 + 12 })
  const brief = (laneX: number): Rect => ({ x: laneX + 12, y: 88, w: 400, h: 64 })
  const channel = 58 + 106 + 6

  it('mãe → 2 filhas: o mesmo tronco e uma descida por filha, pela borda inferior', () => {
    const mae = brief(12)
    const otavio = brief(452)
    const marina = brief(892)
    const a = gutterRoute(mae, shortLane(12), otavio, shortLane(452), channel)
    const b = gutterRoute(mae, shortLane(12), marina, shortLane(892), channel)
    expect(a[0]).toEqual({ x: mae.x + 200, y: mae.y + mae.h })
    expect(b[0]).toEqual(a[0])
    expect(a.at(-1)).toEqual({ x: otavio.x + 200, y: otavio.y + otavio.h })
    expect(b.at(-1)).toEqual({ x: marina.x + 200, y: marina.y + marina.h })
    // O fio da marina não entra em nenhum cartão, nem passa pela lateral do otavio.
    expect(crosses(b, otavio)).toBe(false)
    expect(b.every((p) => p.y >= mae.y + mae.h)).toBe(true)
  })

  it('filha com cartões abaixo na raia: entra pela lateral (pela calha), não atravessa', () => {
    const mae = brief(12)
    const tgt = card(452, 88)
    const below = card(452, 292)
    const pts = gutterRoute(mae, shortLane(12), tgt, lane(452), 680)
    expect(pts[0].y).toBe(mae.y + mae.h)
    expect(pts.at(-1)).toEqual({ x: tgt.x, y: tgt.y + 28 })
    expect(crosses(pts, below)).toBe(false)
  })
})
