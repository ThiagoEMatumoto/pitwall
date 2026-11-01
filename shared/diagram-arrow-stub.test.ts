import { describe, expect, it } from "vitest";
import {
  applyPatch,
  skeletonToElements,
} from "../electron/main/services/diagram-layout";
import {
  isLayoutNode,
  type DiagramSkeletonElement,
} from "./diagram-skeleton";
import { MIN_ARROWHEAD_STUB, routeCrossings } from "./diagram-route";

type AnyEl = Record<string, any>;
type Pt = [number, number];

const entity = (id: string, fields: string[]): DiagramSkeletonElement => ({
  id,
  type: "entity",
  name: id,
  fields: fields.map((name, i) => ({ name, type: "uuid", pk: i === 0 })),
});
const rel = (
  id: string,
  start: string,
  end: string,
  relation: DiagramSkeletonElement["relation"],
): DiagramSkeletonElement => ({
  id,
  type: "arrow",
  start: { id: start },
  end: { id: end },
  relation,
});

// O ER da validação no app: order_items é N de orders e de products.
const er: DiagramSkeletonElement[] = [
  entity("users", ["id", "email", "name"]),
  entity("orders", ["id", "user_id", "total_cents", "created_at"]),
  entity("order_items", ["id", "order_id", "product_id", "qty"]),
  entity("products", ["id", "name", "price_cents"]),
  rel("r1", "users", "orders", "1:N"),
  rel("r2", "orders", "order_items", "1:N"),
  rel("r3", "products", "order_items", "1:N"),
];

const uml: DiagramSkeletonElement[] = [
  {
    id: "owner",
    type: "class",
    name: "Owner",
    attributes: ["+ name: string"],
    methods: ["+ adopt(a: Animal): void"],
  },
  {
    id: "animal",
    type: "class",
    name: "Animal",
    attributes: ["+ name: string"],
    methods: ["+ speak(): void"],
  },
  {
    id: "dog",
    type: "class",
    name: "Dog",
    attributes: [],
    methods: ["+ fetch(): void"],
  },
  {
    id: "cat",
    type: "class",
    name: "Cat",
    attributes: [],
    methods: ["+ purr(): void"],
  },
  rel("a1", "owner", "animal", "aggregation"),
  rel("i1", "dog", "animal", "inheritance"),
  rel("i2", "cat", "animal", "inheritance"),
];

const absRoute = (a: AnyEl): Pt[] =>
  a.points.map(([x, y]: Pt) => [a.x + x, a.y + y]);
const seg = (p: Pt, q: Pt) => Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);

function expectRoomyHeads(els: AnyEl[]) {
  const nodes = els.filter((e) => (isLayoutNode as (e: AnyEl) => boolean)(e));
  const arrows = els.filter((e) => e.type === "arrow");
  expect(arrows.length).toBeGreaterThan(0);
  for (const arrow of arrows) {
    const route = absRoute(arrow);
    for (let i = 1; i < route.length; i++) {
      const orthogonal =
        Math.abs(route[i][0] - route[i - 1][0]) < 0.5 ||
        Math.abs(route[i][1] - route[i - 1][1]) < 0.5;
      expect(orthogonal, `${arrow.id} segmento ${i} diagonal`).toBe(true);
    }
    if (arrow.startArrowhead) {
      expect(
        seg(route[0], route[1]),
        `${arrow.id} toco inicial (${arrow.startArrowhead})`,
      ).toBeGreaterThanOrEqual(MIN_ARROWHEAD_STUB);
    }
    if (arrow.endArrowhead) {
      expect(
        seg(route.at(-2)!, route.at(-1)!),
        `${arrow.id} toco final (${arrow.endArrowhead})`,
      ).toBeGreaterThanOrEqual(MIN_ARROWHEAD_STUB);
    }
    expect(routeCrossings(route, nodes as any), `${arrow.id} cruza nó`).toBe(0);
  }
}

describe("toco mínimo nas pontas das setas elbow", () => {
  for (const direction of ["LR", "TB"] as const) {
    it(`ER 4 entidades 1:N (${direction}): crowfoot_one não some na dobra`, async () => {
      expectRoomyHeads((await skeletonToElements(er, { direction })) as AnyEl[]);
    });

    it(`UML com agregação (${direction}): losango não some na dobra`, async () => {
      expectRoomyHeads((await skeletonToElements(uml, { direction })) as AnyEl[]);
    });
  }

  it("patch que reroteia as setas mantém o toco", async () => {
    const els = await skeletonToElements(er);
    const out = (await applyPatch(els, [
      { op: "update", id: "orders", fields: [{ name: "id", pk: true }] },
    ])) as AnyEl[];
    expectRoomyHeads(out);
  });
});
