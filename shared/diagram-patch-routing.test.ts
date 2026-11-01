import { describe, expect, it } from "vitest";
import {
  applyPatch,
  skeletonToElements,
} from "../electron/main/services/diagram-layout";
import {
  elbowGeometry,
  orthogonalRoute,
  pinMovedNodes,
  positionsOf,
  type DiagramDirection,
  type DiagramPatchOp,
  type DiagramSkeletonElement,
  type Point,
} from "./diagram-skeleton";
import { avoidingRoute, pointOnBorder, routeCrossings } from "./diagram-route";

type AnyEl = Record<string, any>;

const fanOut: DiagramSkeletonElement[] = [
  { id: "api", type: "rectangle", label: { text: "API Gateway" } },
  { id: "auth", type: "rectangle", label: { text: "Serviço de autenticação" } },
  { id: "billing", type: "rectangle", label: { text: "Cobrança" } },
  { id: "search", type: "rectangle", label: { text: "Busca" } },
  { id: "e1", type: "arrow", start: { id: "api" }, end: { id: "auth" } },
  { id: "e2", type: "arrow", start: { id: "api" }, end: { id: "billing" } },
  {
    id: "e3",
    type: "arrow",
    start: { id: "api" },
    end: { id: "search" },
    label: { text: "query" },
  },
];

/**
 * Arrasta nós no "editor": as setas presas a eles acompanham (rota ortogonal
 * simples, como o editor deixa) e o pinMovedNodes marca os nós como pinados.
 */
function drag(els: AnyEl[], moves: Record<string, { x: number; y: number }>) {
  const baseline = positionsOf(els);
  const moved = els.map((e) => {
    const owner = e.containerId ?? e.id;
    const to = moves[owner];
    if (!to) return e;
    const node = els.find((n) => n.id === owner)!;
    return { ...e, x: e.x + to.x - node.x, y: e.y + to.y - node.y };
  });
  const byId = new Map(moved.map((e) => [e.id, e]));
  const dragged = moved.map((e) => {
    if (e.type !== "arrow") return e;
    const start = byId.get(e.startBinding.elementId)!;
    const end = byId.get(e.endBinding.elementId)!;
    if (!moves[start.id] && !moves[end.id]) return e;
    return { ...e, ...elbowGeometry(orthogonalRoute(start, end), start, end) };
  });
  return pinMovedNodes(dragged, baseline) as AnyEl[];
}

const addCache = (pos?: { x: number; y: number }): DiagramPatchOp[] => [
  {
    op: "add",
    element: {
      id: "cache",
      type: "rectangle",
      label: { text: "Cache Redis" },
      ...pos,
    },
  },
  {
    op: "add",
    element: {
      id: "e4",
      type: "arrow",
      start: { id: "billing" },
      end: { id: "cache" },
    },
  },
];

const absRoute = (a: AnyEl): Point[] =>
  a.points.map(([x, y]: Point) => [a.x + x, a.y + y] as Point);

/** Toda seta: não cruza nó alheio e as duas pontas tocam a borda dos seus nós. */
function expectCleanArrows(result: AnyEl[]) {
  const live = result.filter((e) => !e.isDeleted);
  const nodes = live.filter(
    (e) => e.type !== "arrow" && e.type !== "line" && !e.containerId,
  );
  const arrows = live.filter((e) => e.type === "arrow");
  expect(arrows.length).toBeGreaterThan(0);
  for (const arrow of arrows) {
    const route = absRoute(arrow);
    const start = nodes.find((n) => n.id === arrow.startBinding.elementId)!;
    const end = nodes.find((n) => n.id === arrow.endBinding.elementId)!;
    const others = nodes.filter((n) => n !== start && n !== end);
    for (const other of others) {
      expect(
        routeCrossings(route, [other]),
        `${arrow.id} cruza ${other.id}: ${JSON.stringify(route)}`,
      ).toBe(0);
    }
    expect(pointOnBorder(route[0], start), `${arrow.id} solta da origem`).toBe(
      true,
    );
    expect(
      pointOnBorder(route[route.length - 1], end),
      `${arrow.id} solta do destino`,
    ).toBe(true);
  }
}

describe("regressão: seta existente atravessa nó novo do patch", () => {
  it("cena do relato: api→search não corta 'Cache Redis' a caminho de 'Busca'", async () => {
    const els = (await skeletonToElements(fanOut)) as AnyEl[];
    const pinned = drag(els, {
      billing: { x: 280, y: 200 },
      search: { x: 280, y: 500 },
    });
    const result = (await applyPatch(
      pinned,
      addCache({ x: 280, y: 390 }),
    )) as AnyEl[];
    const cache = result.find((e) => e.id === "cache")!;
    const search = result.find((e) => e.id === "search")!;
    expect([cache.x, cache.y, cache.width, cache.height]).toEqual([
      280, 390, 180, 70,
    ]);
    expect([search.x, search.y]).toEqual([280, 500]);
    const query = result.find((e) => e.id === "e3")!;
    expect(routeCrossings(absRoute(query), [cache])).toBe(0);
    expectCleanArrows(result);

    // O label 'query' acompanha a seta reroteada e não fica sobre o cache.
    const label = result.find((e) => e.id === "e3__label")!;
    const overlapsCache =
      label.x < cache.x + cache.width &&
      cache.x < label.x + label.width &&
      label.y < cache.y + cache.height &&
      cache.y < label.y + label.height;
    expect(overlapsCache).toBe(false);
  });

  const drags: Array<[DiagramDirection, number, number]> = [
    ["LR", 0, 70],
    ["LR", 0, 100],
    ["LR", 40, 70],
    ["LR", 150, -40],
    ["TB", 80, 0],
    ["TB", 0, 40],
  ];
  it.each(drags)(
    "%s, billing arrastado (%i,%i) + cache auto: nenhuma seta cruza nó alheio",
    async (direction, dx, dy) => {
      const els = (await skeletonToElements(fanOut, { direction })) as AnyEl[];
      const billing = els.find((e) => e.id === "billing")!;
      const pinned = drag(els, {
        billing: { x: billing.x + dx, y: billing.y + dy },
      });
      const result = (await applyPatch(pinned, addCache(), {
        direction,
      })) as AnyEl[];
      expectCleanArrows(result);
    },
  );

  it("pai auto é recentrado nos filhos auto quando um irmão foi arrastado", async () => {
    const els = (await skeletonToElements(fanOut)) as AnyEl[];
    const billing = els.find((e) => e.id === "billing")!;
    const pinned = drag(els, { billing: { x: billing.x, y: billing.y + 70 } });
    const result = (await applyPatch(pinned, addCache())) as AnyEl[];
    const get = (id: string) => result.find((e) => e.id === id)!;
    const cy = (e: AnyEl) => e.y + e.height / 2;
    const mean = (cy(get("auth")) + cy(get("search"))) / 2;
    expect(Math.abs(cy(get("api")) - mean)).toBeLessThanOrEqual(1);
  });
});

describe("avoidingRoute", () => {
  const a = { x: 0, y: 0, width: 100, height: 50 };
  const b = { x: 0, y: 300, width: 100, height: 50 };

  it("sem obstáculo usa a rota direta", () => {
    expect(avoidingRoute(a, b, [])).toEqual([
      [50, 50],
      [50, 300],
    ]);
  });

  it("contorna um obstáculo no caminho pela lateral", () => {
    const wall = { x: 0, y: 150, width: 100, height: 50 };
    const route = avoidingRoute(a, b, [wall]);
    expect(routeCrossings(route, [a, b, wall])).toBe(0);
    expect(pointOnBorder(route[0], a)).toBe(true);
    expect(pointOnBorder(route[route.length - 1], b)).toBe(true);
    for (let i = 1; i < route.length; i++) {
      const [p, q] = [route[i - 1], route[i]];
      expect(p[0] === q[0] || p[1] === q[1]).toBe(true);
    }
  });
});
