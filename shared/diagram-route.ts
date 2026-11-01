// Roteamento ortogonal com desvio de obstáculos, usado quando a rota do ELK
// não vale (ponta pinada, nó deslocado, ou a rota do ELK atravessa um nó que
// o ELK não conhecia). TS puro, sem DOM.
import { orthogonalRoute, type Box, type Point } from "./diagram-skeleton";

// Folga entre a seta e a lateral de um obstáculo que ela contorna.
const DETOUR_CLEARANCE = 30;
// Distância máxima entre a ponta da seta e a borda do nó pra contar como presa.
const ENDPOINT_TOLERANCE = 6;
const EPS = 0.5;

/** O segmento ortogonal p→q entra no interior aberto da caixa? */
function segmentHitsBox(p: Point, q: Point, box: Box): boolean {
  const minX = Math.min(p[0], q[0]);
  const maxX = Math.max(p[0], q[0]);
  const minY = Math.min(p[1], q[1]);
  const maxY = Math.max(p[1], q[1]);
  return (
    maxX > box.x + EPS &&
    minX < box.x + box.width - EPS &&
    maxY > box.y + EPS &&
    minY < box.y + box.height - EPS
  );
}

/** Quantos pares (segmento, caixa) se cruzam. */
export function routeCrossings(route: Point[], boxes: readonly Box[]): number {
  let hits = 0;
  for (let i = 1; i < route.length; i++) {
    for (const box of boxes) {
      if (segmentHitsBox(route[i - 1], route[i], box)) hits++;
    }
  }
  return hits;
}

/** O ponto está na borda da caixa (com tolerância)? */
export function pointOnBorder(p: Point, box: Box): boolean {
  const t = ENDPOINT_TOLERANCE;
  const inOuter =
    p[0] >= box.x - t &&
    p[0] <= box.x + box.width + t &&
    p[1] >= box.y - t &&
    p[1] <= box.y + box.height + t;
  const inInner =
    p[0] > box.x + t &&
    p[0] < box.x + box.width - t &&
    p[1] > box.y + t &&
    p[1] < box.y + box.height - t;
  return inOuter && !inInner;
}

const routeLength = (route: Point[]) =>
  route.reduce(
    (sum, p, i) =>
      i === 0
        ? 0
        : sum +
          Math.abs(p[0] - route[i - 1][0]) +
          Math.abs(p[1] - route[i - 1][1]),
    0,
  );

const cx = (b: Box) => b.x + b.width / 2;
const cy = (b: Box) => b.y + b.height / 2;

/** L com 1 bend: sai pela lateral (esq/dir) de a e entra por cima/baixo de b, e o inverso. */
function lRoutes(a: Box, b: Box): Point[][] {
  const out: Point[][] = [];
  // Horizontal saindo de a, vertical entrando em b.
  if (cx(b) > a.x + a.width || cx(b) < a.x) {
    const sx = cx(b) > a.x + a.width ? a.x + a.width : a.x;
    if (cy(a) < b.y)
      out.push([
        [sx, cy(a)],
        [cx(b), cy(a)],
        [cx(b), b.y],
      ]);
    if (cy(a) > b.y + b.height) {
      out.push([
        [sx, cy(a)],
        [cx(b), cy(a)],
        [cx(b), b.y + b.height],
      ]);
    }
  }
  // Vertical saindo de a, horizontal entrando em b.
  if (cy(b) > a.y + a.height || cy(b) < a.y) {
    const sy = cy(b) > a.y + a.height ? a.y + a.height : a.y;
    if (cx(a) < b.x)
      out.push([
        [cx(a), sy],
        [cx(a), cy(b)],
        [b.x, cy(b)],
      ]);
    if (cx(a) > b.x + b.width) {
      out.push([
        [cx(a), sy],
        [cx(a), cy(b)],
        [b.x + b.width, cy(b)],
      ]);
    }
  }
  return out;
}

/**
 * Z/U com 2 bends: corredor vertical em x=mid (sai e entra pelas laterais) ou
 * horizontal em y=mid (sai e entra por cima/baixo). O corredor precisa ficar
 * fora da faixa das duas caixas pra o primeiro e o último segmento saírem
 * pra fora delas.
 */
function zRoutes(a: Box, b: Box, obstacles: readonly Box[]): Point[][] {
  const out: Point[][] = [];
  const all = [a, b, ...obstacles];
  const c = DETOUR_CLEARANCE;
  const xs = new Set<number>([
    (Math.max(a.x + a.width, b.x + b.width) + Math.min(a.x, b.x)) / 2,
    (a.x + a.width + b.x) / 2,
    (b.x + b.width + a.x) / 2,
  ]);
  const ys = new Set<number>([
    (a.y + a.height + b.y) / 2,
    (b.y + b.height + a.y) / 2,
  ]);
  for (const o of all) {
    xs.add(o.x - c);
    xs.add(o.x + o.width + c);
    ys.add(o.y - c);
    ys.add(o.y + o.height + c);
  }
  const outsideX = (v: number, box: Box) =>
    v >= box.x + box.width || v <= box.x;
  const outsideY = (v: number, box: Box) =>
    v >= box.y + box.height || v <= box.y;
  for (const mid of xs) {
    if (!outsideX(mid, a) || !outsideX(mid, b)) continue;
    const sx = mid >= a.x + a.width ? a.x + a.width : a.x;
    const ex = mid >= b.x + b.width ? b.x + b.width : b.x;
    out.push([
      [sx, cy(a)],
      [mid, cy(a)],
      [mid, cy(b)],
      [ex, cy(b)],
    ]);
  }
  for (const mid of ys) {
    if (!outsideY(mid, a) || !outsideY(mid, b)) continue;
    const sy = mid >= a.y + a.height ? a.y + a.height : a.y;
    const ey = mid >= b.y + b.height ? b.y + b.height : b.y;
    out.push([
      [cx(a), sy],
      [cx(a), mid],
      [cx(b), mid],
      [cx(b), ey],
    ]);
  }
  return out;
}

/** Remove pontos colineares e repetidos (Z com corredor alinhado vira reta). */
function simplify(route: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of route) {
    const last = out[out.length - 1];
    if (
      last &&
      Math.abs(last[0] - p[0]) < EPS &&
      Math.abs(last[1] - p[1]) < EPS
    ) {
      continue;
    }
    if (out.length >= 2) {
      const prev = out[out.length - 2];
      const sameX =
        Math.abs(prev[0] - last[0]) < EPS && Math.abs(last[0] - p[0]) < EPS;
      const sameY =
        Math.abs(prev[1] - last[1]) < EPS && Math.abs(last[1] - p[1]) < EPS;
      if (sameX || sameY) out.pop();
    }
    out.push(p);
  }
  return out;
}

/**
 * Rota ortogonal de a até b que desvia dos obstáculos: tenta a rota padrão,
 * depois L (1 bend) e Z/U (2 bends) pelas laterais, da mais curta pra mais
 * longa, e fica com a primeira sem colisão; sem nenhuma livre, a de menos
 * interseções. As próprias caixas a e b também contam (a seta não pode
 * atravessar a origem nem o destino).
 */
export function avoidingRoute(
  a: Box,
  b: Box,
  obstacles: readonly Box[],
): Point[] {
  const boxes = [a, b, ...obstacles];
  const preferred = orthogonalRoute(a, b);
  if (routeCrossings(preferred, boxes) === 0) return preferred;
  const candidates = [...lRoutes(a, b), ...zRoutes(a, b, obstacles)]
    .map(simplify)
    .sort((r1, r2) => routeLength(r1) - routeLength(r2));
  let best = preferred;
  let bestHits = routeCrossings(preferred, boxes);
  for (const route of candidates) {
    const hits = routeCrossings(route, boxes);
    if (hits === 0) return route;
    if (hits < bestHits) {
      best = route;
      bestHits = hits;
    }
  }
  return best;
}

// Toco mínimo entre o nó e a primeira dobra quando há ponta naquele lado:
// abaixo disso o crowfoot/losango some espremido na curva da seta elbow.
export const MIN_ARROWHEAD_STUB = 32;
// Último segmento sem ponta: não pode zerar (a seta entraria pelo lado errado).
const MIN_PLAIN_STUB = 8;

/**
 * Alonga o primeiro segmento até `min` empurrando o segundo segmento pra
 * longe do nó; o terceiro encolhe, mas não abaixo de `reserve`. Rota de 1
 * dobra só cede se o ponto final continuar na mesma borda de `endBox`.
 */
function stretchFirst(
  route: Point[],
  min: number,
  reserve: number,
  endBox: Box,
): Point[] | null {
  const [p0, p1, p2, p3] = route;
  const k = Math.abs(p1[0] - p0[0]) >= Math.abs(p1[1] - p0[1]) ? 0 : 1;
  const len = Math.abs(p1[k] - p0[k]);
  if (len >= min) return route;
  if (len < EPS) return null;
  const s = Math.sign(p1[k] - p0[k]);
  let delta = min - len;
  if (route.length === 3) {
    const lo = k === 0 ? endBox.x : endBox.y;
    const hi = lo + (k === 0 ? endBox.width : endBox.height);
    const next = p2[k] + s * delta;
    if (next < lo + EPS || next > hi - EPS) return null;
  } else {
    const ext = (p3[k] - p2[k]) * s;
    if (ext > 0) delta = Math.min(delta, ext - reserve);
    if (delta < EPS) return null;
  }
  const shift = (p: Point): Point =>
    k === 0 ? [p[0] + s * delta, p[1]] : [p[0], p[1] + s * delta];
  return [p0, shift(p1), shift(p2), ...route.slice(3)];
}

/**
 * Garante MIN_ARROWHEAD_STUB no primeiro/último segmento da rota elbow que
 * tem ponta naquele lado, mantendo a ortogonalidade. Se o ajuste fizer a
 * rota cruzar mais caixas que a original, fica a original.
 */
export function withArrowheadStubs(
  route: Point[],
  start: Box,
  end: Box,
  heads: { start: boolean; end: boolean },
  obstacles: readonly Box[],
): Point[] {
  if (route.length < 3 || (!heads.start && !heads.end)) return route;
  const endReserve = heads.end ? MIN_ARROWHEAD_STUB : MIN_PLAIN_STUB;
  const startReserve = heads.start ? MIN_ARROWHEAD_STUB : MIN_PLAIN_STUB;
  let out = route;
  if (heads.start) {
    out = stretchFirst(out, MIN_ARROWHEAD_STUB, endReserve, end) ?? out;
  }
  if (heads.end) {
    const rev = stretchFirst(
      [...out].reverse(),
      MIN_ARROWHEAD_STUB,
      startReserve,
      start,
    );
    if (rev) out = rev.reverse();
  }
  if (out === route) return route;
  const boxes = [start, end, ...obstacles];
  return routeCrossings(out, boxes) > routeCrossings(route, boxes)
    ? route
    : out;
}
