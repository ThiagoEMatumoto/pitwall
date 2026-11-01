// Onde o label de uma seta aparece e como tirá-lo de cima de nós/setas.
// O Excalidraw ignora o x/y gravado no texto de uma seta: desenha no vértice
// do meio (nº ímpar de pontos) ou no meio do segmento do meio (nº par) —
// LinearElementEditor.getBoundTextElementPosition. Pra escolher o lugar do
// label, a rota ganha vértices colineares (invisíveis) até o ponto escolhido
// virar o vértice do meio.
import type { Box, Point } from './diagram-skeleton'

const LABEL_MARGIN = 6

/** Centro do label como o Excalidraw desenha (pontos em coordenadas absolutas). */
export function renderedLabelCenter(route: readonly Point[]): Point {
  const n = route.length
  if (n % 2 === 1) return route[Math.floor(n / 2)]
  const a = route[n / 2 - 1]
  const b = route[n / 2]
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}

export function labelBox(center: Point, size: { width: number; height: number }): Box {
  return {
    x: center[0] - size.width / 2,
    y: center[1] - size.height / 2,
    width: size.width,
    height: size.height,
  }
}

const boxesOverlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** Segmento como caixa de espessura zero (rotas são ortogonais). */
export function segmentBox(a: Point, b: Point): Box {
  const x = Math.min(a[0], b[0])
  const y = Math.min(a[1], b[1])
  return { x, y, width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) }
}

/** Segmento cruza a caixa (borda inclusa)? */
export function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
  const s = segmentBox(a, b)
  return (
    s.x <= box.x + box.width &&
    box.x <= s.x + s.width &&
    s.y <= box.y + box.height &&
    box.y <= s.y + s.height
  )
}

export interface LabelObstacles {
  boxes: readonly Box[]
  segments: readonly (readonly [Point, Point])[]
}

function isFree(box: Box, obstacles: LabelObstacles): boolean {
  const padded = {
    x: box.x - LABEL_MARGIN,
    y: box.y - LABEL_MARGIN,
    width: box.width + 2 * LABEL_MARGIN,
    height: box.height + 2 * LABEL_MARGIN,
  }
  return (
    obstacles.boxes.every((b) => !boxesOverlap(padded, b)) &&
    obstacles.segments.every(([a, b]) => !segmentHitsBox(a, b, padded))
  )
}

const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
const len = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** Insere vértices colineares até `at` (índice de vértice) ficar no meio. */
function centerVertex(route: Point[], at: number): Point[] {
  const pts = [...route]
  let c = at
  for (;;) {
    const before = c
    const after = pts.length - 1 - c
    if (before === after) return pts
    // Parte o segmento mais longo do lado que tem menos vértices.
    const [from, to] = before < after ? [0, c] : [c, pts.length - 1]
    let best = from
    for (let i = from; i < to; i++) {
      if (len(pts[i], pts[i + 1]) > len(pts[best], pts[best + 1])) best = i
    }
    pts.splice(best + 1, 0, mid(pts[best], pts[best + 1]))
    if (best < c) c++
  }
}

/**
 * Rota em que o label renderizado não encosta em nenhum obstáculo. Fica a
 * rota original quando o lugar padrão já está livre; senão tenta o meio de
 * cada segmento que comporta o label (horizontais e mais longos primeiro).
 * Os segmentos da própria seta, exceto o que recebe o label, também contam.
 */
export function placeLabelOnRoute(
  route: readonly Point[],
  size: { width: number; height: number },
  obstacles: LabelObstacles,
): Point[] {
  const own = (skip: number) =>
    route
      .slice(1)
      .map((p, i) => [route[i], p] as const)
      .filter((_, i) => i !== skip)
  const withOwn = (skip: number): LabelObstacles => ({
    boxes: obstacles.boxes,
    segments: [...obstacles.segments, ...own(skip)],
  })

  const current = renderedLabelCenter(route)
  const n = route.length
  // Segmento que contém o centro atual (o do meio, ou os dois do vértice do meio).
  const currentSegs = n % 2 === 0 ? [n / 2 - 1] : [n / 2 - 1.5, n / 2 - 0.5]
  const currentFree = isFree(labelBox(current, size), {
    boxes: obstacles.boxes,
    segments: [...obstacles.segments, ...own(-1).filter((_, i) => !currentSegs.includes(i))],
  })
  if (currentFree) return [...route]

  const candidates = route
    .slice(1)
    .map((p, i) => ({ i, a: route[i], b: p }))
    .filter(({ a, b }) => {
      const horizontal = a[1] === b[1]
      const need = (horizontal ? size.width : size.height) + 2 * LABEL_MARGIN
      return len(a, b) >= need
    })
    .sort((s, t) => {
      const sh = s.a[1] === s.b[1] ? 0 : 1
      const th = t.a[1] === t.b[1] ? 0 : 1
      return sh - th || len(t.a, t.b) - len(s.a, s.b)
    })
  for (const { i, a, b } of candidates) {
    const center = mid(a, b)
    if (!isFree(labelBox(center, size), withOwn(i))) continue
    const split = [...route.slice(0, i + 1), center, ...route.slice(i + 1)]
    return centerVertex(split, i + 1)
  }
  return [...route]
}
