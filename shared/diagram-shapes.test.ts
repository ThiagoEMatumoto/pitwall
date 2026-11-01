import { describe, expect, it } from "vitest";
import {
  applyPatch,
  skeletonToElements,
} from "../electron/main/services/diagram-layout";
import {
  buildElements,
  elementsLayoutGraph,
  elementsToSkeleton,
  isLayoutNode,
  pinMovedNodes,
  positionsOf,
  type DiagramSkeletonElement,
  type ExElement,
  type ExLinear,
} from "./diagram-skeleton";
import { formatField, parseField } from "./diagram-shapes";
import { routeCrossings } from "./diagram-route";
import { measureText } from "./text-measure";

type AnyEl = Record<string, any>;

const users: DiagramSkeletonElement = {
  id: "users",
  type: "entity",
  name: "users",
  fields: [
    { name: "id", type: "uuid", pk: true },
    { name: "email", type: "text" },
    { name: "org_id", type: "uuid", fk: true },
  ],
};

const er4: DiagramSkeletonElement[] = [
  users,
  {
    id: "orgs",
    type: "entity",
    name: "orgs",
    fields: [
      { name: "id", type: "uuid", pk: true },
      { name: "name", type: "text" },
    ],
  },
  {
    id: "orders",
    type: "entity",
    name: "orders",
    fields: [
      { name: "id", type: "uuid", pk: true },
      { name: "user_id", type: "uuid", fk: true },
      { name: "total_cents", type: "integer" },
    ],
  },
  {
    id: "items",
    type: "entity",
    name: "order_items",
    fields: [
      { name: "id", type: "uuid", pk: true },
      { name: "order_id", type: "uuid", fk: true },
    ],
  },
  {
    id: "r1",
    type: "arrow",
    start: { id: "orgs" },
    end: { id: "users" },
    relation: "1:N",
  },
  {
    id: "r2",
    type: "arrow",
    start: { id: "users" },
    end: { id: "orders" },
    relation: "1:N",
  },
  {
    id: "r3",
    type: "arrow",
    start: { id: "orders" },
    end: { id: "items" },
    relation: "1:N",
  },
];

const classes: DiagramSkeletonElement[] = [
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
    id: "i1",
    type: "arrow",
    start: { id: "dog" },
    end: { id: "animal" },
    relation: "inheritance",
  },
];

const byId = (els: unknown[], id: string) =>
  (els as AnyEl[]).find((e) => e.id === id)!;

/** Os textos são bound text: Excalidraw quebra linha acima de width - 10. */
function textFits(els: AnyEl[], text: AnyEl): boolean {
  const cell = els.find((e) => e.id === text.containerId)!;
  const m = measureText(text.text, text.fontSize, text.lineHeight);
  return m.width <= cell.width - 10 && text.width >= m.width - 0.01;
}

const disjoint = (a: AnyEl, b: AnyEl) =>
  a.x + a.width <= b.x ||
  b.x + b.width <= a.x ||
  a.y + a.height <= b.y ||
  b.y + b.height <= a.y;

const absRoute = (a: AnyEl): [number, number][] =>
  a.points.map(([x, y]: [number, number]) => [a.x + x, a.y + y]);

describe("entity", () => {
  it("3 campos geram 1 grupo com header e 3 linhas, larguras comportam o texto", async () => {
    const els = (await skeletonToElements([users])) as AnyEl[];
    const groups = new Set(els.map((e) => e.groupIds.join(",")));
    expect(groups).toEqual(new Set(["users"]));
    const cells = els.filter((e) => e.type === "rectangle" && e.id !== "users");
    expect(cells.map((c) => c.id)).toEqual([
      "users__header",
      "users__f0",
      "users__f1",
      "users__f2",
    ]);
    const header = byId(els, "users__header");
    expect(header.backgroundColor).not.toBe("transparent");
    const texts = els.filter((e) => e.type === "text");
    expect(texts.map((t) => t.text)).toEqual([
      "users",
      "PK id: uuid",
      "email: text",
      "FK org_id: uuid",
    ]);
    for (const t of texts) expect(textFits(els, t)).toBe(true);
    // Linhas empilhadas sem vão dentro do dono.
    const owner = byId(els, "users");
    expect(cells[0].y).toBe(owner.y);
    for (let i = 1; i < cells.length; i++) {
      expect(cells[i].y).toBeCloseTo(cells[i - 1].y + cells[i - 1].height, 5);
    }
    const last = cells[cells.length - 1];
    expect(last.y + last.height).toBeCloseTo(owner.y + owner.height, 5);
    expect(cells.every((c) => c.width === owner.width)).toBe(true);
    // Só o dono é nó de layout.
    expect((els as ExElement[]).filter(isLayoutNode).map((e) => e.id)).toEqual([
      "users",
    ]);
    expect(owner.customData.pitwall.kind).toBe("entity");
  });

  it("formatField/parseField são inversos", () => {
    for (const f of users.fields!)
      expect(parseField(formatField(f))).toEqual(f);
  });
});

describe("class", () => {
  it("3 compartimentos: nome, atributos, métodos", async () => {
    const els = (await skeletonToElements(classes)) as AnyEl[];
    const cells = els.filter(
      (e) => e.groupIds[0] === "animal" && e.type === "rectangle",
    );
    expect(cells.map((c) => c.id)).toEqual([
      "animal",
      "animal__header",
      "animal__attrs",
      "animal__methods",
    ]);
    // Compartimento vazio existe, sem texto.
    expect(byId(els, "dog__attrs")).toBeDefined();
    expect(els.find((e) => e.id === "dog__attrs__text")).toBeUndefined();
  });

  it("inheritance gera triangle_outline no destino", async () => {
    const els = await skeletonToElements(classes);
    const arrow = byId(els, "i1");
    expect(arrow.startArrowhead).toBeNull();
    expect(arrow.endArrowhead).toBe("triangle_outline");
    expect(arrow.startBinding.elementId).toBe("dog");
    expect(arrow.endBinding.elementId).toBe("animal");
  });
});

describe("relations", () => {
  it("1:N gera crowfoot", async () => {
    const els = await skeletonToElements(er4);
    const r = byId(els, "r1");
    expect(r.startArrowhead).toBe("crowfoot_one");
    expect(r.endArrowhead).toBe("crowfoot_many");
  });
});

describe("round-trip", () => {
  it("skeleton → elements → skeleton preserva entity/class/group/frame/relation", async () => {
    const skeleton: DiagramSkeletonElement[] = [
      ...er4,
      ...classes,
      {
        id: "g",
        type: "group",
        label: { text: "Domínio" },
        children: ["orders", "items"],
      },
      { id: "f", type: "frame", name: "Modelo", children: ["animal", "dog"] },
    ];
    const els = await skeletonToElements(skeleton);
    const back = elementsToSkeleton(els);
    const sortById = (xs: DiagramSkeletonElement[]) =>
      [...xs].sort((a, b) => a.id.localeCompare(b.id));
    const strip = (xs: DiagramSkeletonElement[]) =>
      sortById(xs).map((s) =>
        s.children ? { ...s, children: [...s.children].sort() } : s,
      );
    expect(strip(back)).toEqual(strip(skeleton));
    // E o skeleton reconstruído gera a mesma cena estrutural.
    const again = await skeletonToElements(back);
    expect(
      elementsToSkeleton(again)
        .map((s) => s.id)
        .sort(),
    ).toEqual(back.map((s) => s.id).sort());
  });

  it("texto de campo editado no editor vence o customData", async () => {
    const els = (await skeletonToElements([users])) as AnyEl[];
    const edited = els.map((e) =>
      e.id === "users__f1__text"
        ? { ...e, text: "email: citext", originalText: "email: citext" }
        : e,
    );
    const [skel] = elementsToSkeleton(edited);
    expect(skel.fields![1]).toEqual({ name: "email", type: "citext" });
  });
});

describe("group e frame", () => {
  const skeleton: DiagramSkeletonElement[] = [
    { id: "a", type: "rectangle", label: { text: "Gateway" } },
    { id: "b", type: "rectangle", label: { text: "Auth" } },
    { id: "c", type: "rectangle", label: { text: "Billing" } },
    { id: "e1", type: "arrow", start: { id: "a" }, end: { id: "b" } },
    { id: "e2", type: "arrow", start: { id: "a" }, end: { id: "c" } },
    { id: "f", type: "frame", name: "Backend", children: ["b", "c"] },
  ];

  it("filhos do frame ficam dentro da caixa do frame e têm frameId", async () => {
    const els = (await skeletonToElements(skeleton)) as AnyEl[];
    const frame = byId(els, "f");
    expect(frame.type).toBe("frame");
    expect(frame.name).toBe("Backend");
    for (const id of ["b", "c", "b__label", "c__label"]) {
      const el = byId(els, id);
      expect(el.frameId).toBe("f");
      expect(el.x).toBeGreaterThanOrEqual(frame.x);
      expect(el.y).toBeGreaterThanOrEqual(frame.y);
      expect(el.x + el.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(el.y + el.height).toBeLessThanOrEqual(frame.y + frame.height);
    }
    expect(byId(els, "a").frameId).toBeNull();
    expect(disjoint(byId(els, "a"), frame)).toBe(true);
    // Frame por cima dos filhos na ordem z.
    const order = els.map((e) => e.id);
    expect(order.indexOf("f")).toBeGreaterThan(order.indexOf("c"));
  });

  it("rota da aresta que entra no frame termina na borda do filho", async () => {
    const els = (await skeletonToElements(skeleton)) as AnyEl[];
    for (const id of ["e1", "e2"]) {
      const arrow = byId(els, id);
      const route = absRoute(arrow);
      const target = byId(els, arrow.endBinding.elementId);
      const [ex, ey] = route[route.length - 1];
      const onBorder =
        Math.abs(ex - target.x) < 1 ||
        Math.abs(ex - (target.x + target.width)) < 1 ||
        Math.abs(ey - target.y) < 1 ||
        Math.abs(ey - (target.y + target.height)) < 1;
      expect(onBorder).toBe(true);
    }
  });

  it("group recebe groupIds, caixa tracejada com label envolve os filhos", async () => {
    const els = (await skeletonToElements([
      users,
      { id: "x", type: "rectangle", label: { text: "Cache" } },
      {
        id: "g",
        type: "group",
        label: { text: "Core" },
        children: ["users", "x"],
      },
    ])) as AnyEl[];
    const box = byId(els, "g");
    expect(box.strokeStyle).toBe("dashed");
    expect(byId(els, "g__label").containerId).toBe("g");
    for (const e of els.filter((e) => e.id !== "g" && e.id !== "g__label")) {
      expect(e.groupIds[e.groupIds.length - 1]).toBe("g");
    }
    // Bloco: grupo próprio primeiro (interno → externo).
    expect(byId(els, "users__f0").groupIds).toEqual(["users", "g"]);
    for (const id of ["users", "x"]) {
      const el = byId(els, id);
      expect(el.x).toBeGreaterThan(box.x);
      expect(el.y).toBeGreaterThan(box.y + 20);
      expect(el.x + el.width).toBeLessThan(box.x + box.width);
      expect(el.y + el.height).toBeLessThan(box.y + box.height);
    }
  });
});

describe("patch", () => {
  it("trocar fields de entity pinada mantém a posição e reconstrói o bloco", async () => {
    const els = (await skeletonToElements(er4)) as AnyEl[];
    const baseline = positionsOf(els);
    // Arrasta o bloco inteiro (o editor move o grupo junto).
    const moved = els.map((e) =>
      e.groupIds.includes("users") ? { ...e, x: e.x + 400, y: e.y + 300 } : e,
    );
    const pinned = pinMovedNodes(moved, baseline) as AnyEl[];
    const before = byId(pinned, "users");
    expect(before.customData.pitwall.auto).toBe(false);

    const out = (await applyPatch(pinned, [
      {
        op: "update",
        id: "users",
        fields: [
          { name: "id", type: "uuid", pk: true },
          { name: "display_name_for_the_profile_page", type: "text" },
        ],
      },
    ])) as AnyEl[];
    const after = byId(out, "users");
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(after.customData.pitwall.auto).toBe(false);
    expect(byId(out, "users__f1__text").text).toBe(
      "display_name_for_the_profile_page: text",
    );
    expect(byId(out, "users__f2").isDeleted).toBe(true);
    expect(byId(out, "users__f2__text").isDeleted).toBe(true);
    // Bloco mais largo pro campo novo; linha ainda cabe.
    expect(after.width).toBeGreaterThan(before.width);
    const live = out.filter((e) => !e.isDeleted);
    expect(textFits(live, byId(out, "users__f1__text"))).toBe(true);
    // Setas continuam ligadas ao dono.
    expect(after.boundElements.map((b: AnyEl) => b.id).sort()).toEqual([
      "r1",
      "r2",
    ]);
    const [skel] = elementsToSkeleton(out).filter((s) => s.id === "users");
    expect(skel.fields).toHaveLength(2);
  });

  it("delete de entity apaga as partes; delete de grupo solta os filhos", async () => {
    const els = await skeletonToElements([
      ...er4,
      { id: "g", type: "group", children: ["orders", "items"] },
    ]);
    const out = (await applyPatch(els, [
      { op: "delete", id: "items" },
      { op: "delete", id: "g" },
    ])) as AnyEl[];
    expect(
      out.filter((e) => e.id.startsWith("items")).every((e) => e.isDeleted),
    ).toBe(true);
    expect(byId(out, "orders").groupIds).toEqual(["orders"]);
  });

  it("add de group via patch adota filhos existentes e a caixa os envolve", async () => {
    const els = await skeletonToElements(er4);
    const out = (await applyPatch(els, [
      {
        op: "add",
        element: {
          id: "g",
          type: "group",
          label: { text: "Pedidos" },
          children: ["orders", "items"],
        },
      },
    ])) as AnyEl[];
    const box = byId(out, "g");
    for (const id of ["orders", "items"]) {
      const el = byId(out, id);
      expect(el.groupIds).toContain("g");
      expect(el.x).toBeGreaterThan(box.x);
      expect(el.x + el.width).toBeLessThan(box.x + box.width);
      expect(el.y + el.height).toBeLessThan(box.y + box.height);
    }
    expect(
      elementsToSkeleton(out)
        .find((s) => s.id === "g")
        ?.children?.sort(),
    ).toEqual(["items", "orders"]);
  });

  it("update de relation troca as pontas", async () => {
    const els = await skeletonToElements(er4);
    const out = await applyPatch(els, [
      { op: "update", id: "r1", relation: "N:M" },
    ]);
    const r = byId(out, "r1");
    expect(r.startArrowhead).toBe("crowfoot_one_or_many");
    expect(elementsToSkeleton(out).find((s) => s.id === "r1")?.relation).toBe(
      "N:M",
    );
  });
});

describe("layout ER", () => {
  it("4 entidades e 3 relações: sem sobreposição e sem seta cruzando nó", async () => {
    for (const direction of ["LR", "TB"] as const) {
      const els = (await skeletonToElements(er4, { direction })) as AnyEl[];
      const owners = els.filter((e) =>
        (isLayoutNode as (e: AnyEl) => boolean)(e),
      );
      expect(owners).toHaveLength(4);
      for (let i = 0; i < owners.length; i++) {
        for (let j = i + 1; j < owners.length; j++) {
          expect(disjoint(owners[i], owners[j])).toBe(true);
        }
      }
      for (const arrow of els.filter((e) => e.type === "arrow") as ExLinear[]) {
        const others = owners.filter(
          (o) =>
            o.id !== arrow.startBinding!.elementId &&
            o.id !== arrow.endBinding!.elementId,
        );
        expect(routeCrossings(absRoute(arrow), others as any)).toBe(0);
      }
    }
  });

  it("buildElements é síncrono e isomórfico para blocos (sem layout)", () => {
    const els = buildElements(
      [{ ...users, x: 10, y: 20 }],
      {
        positions: new Map(),
        routes: new Map(),
      },
      { layout: "keep" },
    ) as AnyEl[];
    expect(byId(els, "users").x).toBe(10);
    expect(byId(els, "users__header").y).toBe(20);
    expect(byId(els, "users").customData.pitwall.auto).toBe(false);
  });
});

describe("blocos editados no editor", () => {
  const four: DiagramSkeletonElement = {
    id: "a",
    type: "entity",
    name: "A",
    fields: [0, 1, 2, 3].map((i) => ({ name: `campo_${i}`, type: "text" })),
  };
  const deleteIds = (els: unknown[], ids: string[]) =>
    (els as AnyEl[]).map((e) =>
      ids.includes(e.id) ? { ...e, isDeleted: true } : e,
    );

  it("linha do meio apagada não leva junto os campos seguintes", async () => {
    const els = deleteIds(await skeletonToElements([four]), [
      "a__f1",
      "a__f1__text",
    ]);
    const [skel] = elementsToSkeleton(els);
    expect(skel.fields!.map((f) => f.name)).toEqual([
      "campo_0",
      "campo_2",
      "campo_3",
    ]);
    const out = (await applyPatch(els, [
      { op: "update", id: "a", name: "A renomeada" },
    ])) as AnyEl[];
    const texts = out
      .filter((e) => e.type === "text" && !e.isDeleted)
      .map((e) => e.text);
    expect(texts).toEqual([
      "A renomeada",
      "campo_0: text",
      "campo_2: text",
      "campo_3: text",
    ]);
  });

  it("campo esvaziado (só o texto apagado) é pulado, não corta o resto", async () => {
    const els = deleteIds(await skeletonToElements([users]), [
      "users__f1__text",
    ]);
    const [skel] = elementsToSkeleton(els);
    expect(skel.fields!.map((f) => f.name)).toEqual(["id", "org_id"]);
  });

  it("texto digitado num compartimento vazio entra no skeleton e sobrevive ao rebuild", async () => {
    const base = (await skeletonToElements([
      { id: "Animal", type: "class", name: "Animal", attributes: [], methods: [] },
    ])) as AnyEl[];
    const cell = byId(base, "Animal__methods");
    const typed = {
      ...byId(base, "Animal__header__text"),
      id: "rnd123",
      text: "run()",
      originalText: "run()",
      containerId: "Animal__methods",
    };
    const els = [
      ...base.map((e) =>
        e.id === cell.id
          ? { ...e, boundElements: [{ id: "rnd123", type: "text" }] }
          : e,
      ),
      typed,
    ];
    expect(elementsToSkeleton(els)[0].methods).toEqual(["run()"]);

    const out = (await applyPatch(els, [
      { op: "update", id: "Animal", attributes: ["+ name: string"] },
    ])) as AnyEl[];
    expect(elementsToSkeleton(out)[0]).toMatchObject({
      attributes: ["+ name: string"],
      methods: ["run()"],
    });
    // Nenhum bound text vivo fica apontando pra uma célula que não o lista.
    for (const t of out.filter(
      (e) => e.type === "text" && !e.isDeleted && e.containerId,
    )) {
      const container = byId(out, t.containerId);
      expect(container.boundElements.map((b: AnyEl) => b.id)).toContain(t.id);
    }
  });
});

describe("seta ligada a uma célula do bloco", () => {
  /** O hit-test do editor pega a célula (por cima do dono transparente). */
  async function boundToCell() {
    const els = (await skeletonToElements(er4)) as AnyEl[];
    return els.map((e) => {
      if (e.id === "r2") {
        return { ...e, endBinding: { ...e.endBinding, elementId: "orders__f1" } };
      }
      if (e.id === "orders") {
        return {
          ...e,
          boundElements: e.boundElements.filter((b: AnyEl) => b.id !== "r2"),
        };
      }
      if (e.id === "orders__f1") {
        return { ...e, boundElements: [...(e.boundElements ?? []), { id: "r2", type: "arrow" }] };
      }
      return e;
    });
  }

  it("diagram_get e o grafo do ELK enxergam o dono", async () => {
    const els = await boundToCell();
    expect(elementsToSkeleton(els).find((s) => s.id === "r2")?.end).toEqual({
      id: "orders",
    });
    const edge = elementsLayoutGraph(els, "LR").edges.find((e) => e.id === "r2");
    expect(edge).toMatchObject({ source: "users", target: "orders" });
  });

  it("patch que remove o campo religa a seta ao dono", async () => {
    const out = (await applyPatch(await boundToCell(), [
      { op: "update", id: "orders", fields: [{ name: "id", pk: true }] },
    ])) as AnyEl[];
    const r2 = byId(out, "r2");
    expect(r2.endBinding.elementId).toBe("orders");
    expect(byId(out, "orders").boundElements.map((b: AnyEl) => b.id)).toContain("r2");
    expect(byId(out, "orders__f1").isDeleted).toBe(true);
  });
});

describe("frame nativo do editor (sem customData)", () => {
  async function withNativeFrame() {
    const els = (await skeletonToElements([
      { id: "a", type: "rectangle", label: { text: "A" } },
      { id: "b", type: "rectangle", label: { text: "B" } },
      { id: "e1", type: "arrow", start: { id: "a" }, end: { id: "b" } },
    ])) as AnyEl[];
    const a = byId(els, "a");
    const b = byId(els, "b");
    const x = Math.min(a.x, b.x) - 20;
    const y = Math.min(a.y, b.y) - 20;
    const frame = {
      ...a,
      id: "nf",
      type: "frame",
      name: "Mine",
      x,
      y,
      width: Math.max(a.x + a.width, b.x + b.width) + 20 - x,
      height: Math.max(a.y + a.height, b.y + b.height) + 20 - y,
      boundElements: null,
      groupIds: [],
      customData: undefined,
    };
    const inFrame = new Set(["a", "b", "a__label", "b__label"]);
    return [
      ...els.map((e) =>
        inFrame.has(e.id) || inFrame.has(e.containerId)
          ? { ...e, frameId: "nf" }
          : e,
      ),
      frame,
    ];
  }

  it("diagram_get devolve nome e filhos", async () => {
    const skel = elementsToSkeleton(await withNativeFrame());
    const nf = skel.find((s) => s.id === "nf")!;
    expect(nf).toMatchObject({ type: "frame", name: "Mine" });
    expect([...nf.children!].sort()).toEqual(["a", "b"]);
  });

  it("patch que move os filhos leva a caixa do frame junto", async () => {
    const out = (await applyPatch(await withNativeFrame(), [
      { op: "add", element: { id: "c", type: "rectangle", label: { text: "C" } } },
      { op: "add", element: { id: "e2", type: "arrow", start: { id: "c" }, end: { id: "a" } } },
    ])) as AnyEl[];
    const frame = byId(out, "nf");
    for (const id of ["a", "b"]) {
      const el = byId(out, id);
      expect(el.frameId).toBe("nf");
      expect(el.x).toBeGreaterThanOrEqual(frame.x);
      expect(el.y).toBeGreaterThanOrEqual(frame.y);
      expect(el.x + el.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(el.y + el.height).toBeLessThanOrEqual(frame.y + frame.height);
    }
  });
});

describe("frame dentro de frame (o Excalidraw não aninha frames)", () => {
  const boxOf = (els: AnyEl[], id: string) => byId(els, id);
  const nested: DiagramSkeletonElement[] = [
    { id: "a", type: "rectangle", label: { text: "A" } },
    { id: "b", type: "rectangle", label: { text: "B" } },
    { id: "inner", type: "frame", name: "Inner", children: ["a"] },
    { id: "outer", type: "frame", name: "Outer", children: ["inner", "b"] },
  ];

  it("primeiro desenho e round-trip concordam: o frame interno fica ao lado", async () => {
    const els = (await skeletonToElements(nested)) as AnyEl[];
    expect(disjoint(boxOf(els, "inner"), boxOf(els, "outer"))).toBe(true);
    const back = elementsToSkeleton(els);
    expect(back.find((s) => s.id === "outer")?.children).toEqual(["b"]);
    expect(back.find((s) => s.id === "inner")?.children).toEqual(["a"]);
    const again = (await skeletonToElements(back)) as AnyEl[];
    expect(disjoint(boxOf(again, "inner"), boxOf(again, "outer"))).toBe(true);
    expect(byId(again, "a").frameId).toBe("inner");
    expect(byId(again, "b").frameId).toBe("outer");
  });

  it("frame dentro de grupo dentro de frame continua aninhado no round-trip", async () => {
    const skeleton: DiagramSkeletonElement[] = [
      { id: "a", type: "rectangle", label: { text: "A" } },
      { id: "inner", type: "frame", name: "Inner", children: ["a"] },
      { id: "g", type: "group", children: ["inner"] },
      { id: "outer", type: "frame", name: "Outer", children: ["g"] },
    ];
    const els = (await skeletonToElements(skeleton)) as AnyEl[];
    const back = elementsToSkeleton(els);
    expect(back.find((s) => s.id === "outer")?.children).toEqual(["g"]);
    expect(back.find((s) => s.id === "g")?.children).toEqual(["inner"]);
  });
});
