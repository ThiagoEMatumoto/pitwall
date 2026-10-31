import { describe, expect, it } from "vitest";
import {
  applyPatch,
  skeletonToElements,
} from "../electron/main/services/diagram-layout";
import {
  elementsToSkeleton,
  pinMovedNodes,
  positionsOf,
  type DiagramSkeletonElement,
} from "./diagram-skeleton";
import { measureText } from "./text-measure";

type AnyEl = Record<string, any>;

/** Remove campos não-determinísticos pra comparação estrutural. */
function normalize(elements: unknown[]): AnyEl[] {
  return (elements as AnyEl[]).map((el) => {
    const { seed, versionNonce, updated, ...rest } = el;
    return rest;
  });
}

/** AABB estritamente disjuntos (sem sobreposição). */
function disjoint(a: AnyEl, b: AnyEl): boolean {
  return (
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

/** Cadeia linear n0→n1→…→n{n-1}, com label opcional nas setas. */
function chain(
  n: number,
  arrowLabel?: (i: number) => string,
): DiagramSkeletonElement[] {
  const skeleton: DiagramSkeletonElement[] = [];
  for (let i = 0; i < n; i++) {
    skeleton.push({ id: `n${i}`, type: "rectangle", label: { text: `N${i}` } });
  }
  for (let i = 0; i < n - 1; i++) {
    skeleton.push({
      id: `e${i}`,
      type: "arrow",
      start: { id: `n${i}` },
      end: { id: `n${i + 1}` },
      ...(arrowLabel ? { label: { text: arrowLabel(i) } } : {}),
    });
  }
  return skeleton;
}

const flowSkeleton: DiagramSkeletonElement[] = [
  { id: "start", type: "ellipse", label: { text: "Start" } },
  { id: "work", type: "rectangle", label: { text: "Do work" } },
  { id: "done", type: "diamond", label: { text: "Done?" } },
  {
    id: "a1",
    type: "arrow",
    start: { id: "start" },
    end: { id: "work" },
    label: { text: "go" },
  },
  {
    id: "a2",
    type: "arrow",
    start: { id: "work" },
    end: { id: "done" },
    label: { text: "check" },
  },
];

describe("skeletonToElements", () => {
  it("golden: 3 nós + 2 setas com labels (snapshot estrutural)", async () => {
    const elements = await skeletonToElements(flowSkeleton);
    expect(normalize(elements)).toMatchSnapshot();
  });

  it("gera elementos completos e válidos", async () => {
    const elements = (await skeletonToElements(flowSkeleton)) as AnyEl[];
    // 3 shapes + 3 labels + 2 arrows + 2 labels de arrow
    expect(elements).toHaveLength(10);
    for (const el of elements) {
      expect(el.angle).toBe(0);
      expect(el.opacity).toBe(100);
      expect(el.version).toBe(1);
      expect(el.isDeleted).toBe(false);
      expect(el.frameId).toBeNull();
      expect(el.link).toBeNull();
      expect(el.locked).toBe(false);
      expect(Array.isArray(el.groupIds)).toBe(true);
      expect(Number.isInteger(el.seed)).toBe(true);
      expect(Number.isInteger(el.versionNonce)).toBe(true);
      expect(typeof el.updated).toBe("number");
      expect(typeof el.index).toBe("string");
    }
    const rect = elements.find((e) => e.id === "work")!;
    expect(rect.roundness).toEqual({ type: 3 });
    expect(rect.width).toBe(180);
    expect(rect.height).toBe(70);
    expect(rect.strokeColor).toBe("#1e1e1e");
    expect(rect.backgroundColor).toBe("transparent");

    const ellipse = elements.find((e) => e.id === "start")!;
    expect(ellipse.roundness).toBeNull();

    const arrow = elements.find((e) => e.id === "a1")!;
    // Seta entre dois nós = elbow nativa (ortogonal, sem roundness).
    expect(arrow.roundness).toBeNull();
    expect(arrow.elbowed).toBe(true);
    expect(arrow.fixedSegments).toBeNull();
    expect(arrow.startIsSpecial).toBeNull();
    expect(arrow.endIsSpecial).toBeNull();
    expect(arrow.startArrowhead).toBeNull();
    expect(arrow.endArrowhead).toBe("arrow");
    expect(arrow.lastCommittedPoint).toBeNull();
    expect(arrow.points[0]).toEqual([0, 0]);

    // Índices fracionais crescentes.
    const indexes = elements.map((e) => e.index);
    expect([...indexes].sort()).toEqual(indexes);
  });

  it("labels viram text bound com containerId e boundElements no dono", async () => {
    const elements = (await skeletonToElements(flowSkeleton)) as AnyEl[];
    const label = elements.find((e) => e.id === "work__label")!;
    expect(label.type).toBe("text");
    expect(label.containerId).toBe("work");
    expect(label.text).toBe("Do work");
    expect(label.originalText).toBe("Do work");
    expect(label.fontSize).toBe(16);
    expect(label.fontFamily).toBe(5);
    expect(label.textAlign).toBe("center");
    expect(label.verticalAlign).toBe("middle");
    expect(label.autoResize).toBe(true);
    expect(label.lineHeight).toBe(1.25);

    const owner = elements.find((e) => e.id === "work")!;
    expect(owner.boundElements).toContainEqual({
      id: "work__label",
      type: "text",
    });
  });

  it("bindings são simétricos entre arrow e shapes", async () => {
    const elements = (await skeletonToElements(flowSkeleton)) as AnyEl[];
    const arrow = elements.find((e) => e.id === "a1")!;
    expect(arrow.startBinding).toMatchObject({
      elementId: "start",
      focus: 0,
      gap: 4,
    });
    expect(arrow.endBinding).toMatchObject({
      elementId: "work",
      focus: 0,
      gap: 4,
    });
    for (const b of [arrow.startBinding, arrow.endBinding]) {
      for (const v of b.fixedPoint) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }

    const start = elements.find((e) => e.id === "start")!;
    const work = elements.find((e) => e.id === "work")!;
    expect(start.boundElements).toContainEqual({ id: "a1", type: "arrow" });
    expect(work.boundElements).toContainEqual({ id: "a1", type: "arrow" });
    expect(work.boundElements).toContainEqual({ id: "a2", type: "arrow" });
  });

  it("auto-layout é determinístico e em camadas topológicas", async () => {
    const first = (await skeletonToElements(flowSkeleton)) as AnyEl[];
    const second = (await skeletonToElements(flowSkeleton)) as AnyEl[];
    const pos = (els: AnyEl[]) =>
      els.map((e) => ({ id: e.id, x: e.x, y: e.y, points: e.points ?? null }));
    expect(pos(first)).toEqual(pos(second));

    const start = first.find((e) => e.id === "start")!;
    const work = first.find((e) => e.id === "work")!;
    const done = first.find((e) => e.id === "done")!;
    // LR: uma camada por nó, da esquerda pra direita, centros alinhados.
    expect(start.x + start.width).toBeLessThan(work.x);
    expect(work.x + work.width).toBeLessThan(done.x);
    const cy = (e: AnyEl) => e.y + e.height / 2;
    expect(Math.abs(cy(start) - cy(work))).toBeLessThanOrEqual(1);
    expect(Math.abs(cy(work) - cy(done))).toBeLessThanOrEqual(1);
  });

  it("shape cresce pro label longo; diamond cresce mais que rectangle", async () => {
    const text = "Gate humano (aprovação)";
    const elements = (await skeletonToElements([
      { id: "r", type: "rectangle", label: { text } },
      { id: "d", type: "diamond", label: { text } },
    ])) as AnyEl[];
    const rect = elements.find((e) => e.id === "r")!;
    const diamond = elements.find((e) => e.id === "d")!;
    const label = elements.find((e) => e.id === "r__label")!;

    expect(rect.width).toBeGreaterThan(180);
    expect(rect.width).toBeGreaterThanOrEqual(label.width + 48);
    // Texto inscrito no diamond precisa de folga geométrica extra.
    expect(diamond.width).toBeGreaterThan(rect.width);
    expect(rect.height).toBe(70);
  });

  it("width/height explícitos do autor são respeitados mesmo com label longo", async () => {
    const elements = (await skeletonToElements([
      {
        id: "r",
        type: "rectangle",
        width: 120,
        height: 50,
        label: { text: "Gate humano (aprovação)" },
      },
    ])) as AnyEl[];
    expect(elements[0].width).toBe(120);
    expect(elements[0].height).toBe(50);
  });

  it("colunas usam a largura real: nó largo não encosta no vizinho", async () => {
    const wideLabel = "a very very very long label";
    const base: DiagramSkeletonElement[] = [
      { id: "wide", type: "rectangle", label: { text: wideLabel } },
      { id: "next", type: "rectangle", label: { text: "ok" } },
    ];
    const plain = (await skeletonToElements([
      ...base,
      { id: "e", type: "arrow", start: { id: "wide" }, end: { id: "next" } },
    ])) as AnyEl[];
    const wide = plain.find((e) => e.id === "wide")!;
    const next = plain.find((e) => e.id === "next")!;
    expect(wide.width).toBeGreaterThan(180);
    const plainGap = next.x - (wide.x + wide.width);
    expect(plainGap).toBeGreaterThanOrEqual(80);

    // Seta com label entre as colunas → gap maior pro label caber.
    const labeled = (await skeletonToElements([
      ...base,
      {
        id: "e",
        type: "arrow",
        start: { id: "wide" },
        end: { id: "next" },
        label: { text: "pede tarefa" },
      },
    ])) as AnyEl[];
    const wideL = labeled.find((e) => e.id === "wide")!;
    const nextLabeled = labeled.find((e) => e.id === "next")!;
    const label = labeled.find((e) => e.id === "e__label")!;
    expect(nextLabeled.x - (wideL.x + wideL.width)).toBeGreaterThanOrEqual(
      plainGap,
    );
    // O label cabe no vão entre os dois nós.
    expect(label.x).toBeGreaterThanOrEqual(wideL.x + wideL.width);
    expect(label.x + label.width).toBeLessThanOrEqual(nextLabeled.x);
  });

  it("cadeia de 8 nós: gaps entre camadas uniformes e sem sobreposição", async () => {
    const elements = (await skeletonToElements(
      chain(8, (i) => `passo ${i}`),
    )) as AnyEl[];
    const node = (i: number) => elements.find((e) => e.id === `n${i}`)!;
    const gaps: number[] = [];
    for (let i = 0; i < 7; i++) {
      const a = node(i);
      const b = node(i + 1);
      expect(disjoint(a, b)).toBe(true);
      expect(
        Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)),
      ).toBeLessThanOrEqual(1);
      gaps.push(b.x - (a.x + a.width));
    }
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(40);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(80);
  });

  it("direction TB empilha as camadas de cima pra baixo", async () => {
    const elements = (await skeletonToElements(chain(3), {
      direction: "TB",
    })) as AnyEl[];
    const [n0, n1, n2] = [0, 1, 2].map((i) =>
      elements.find((e) => e.id === `n${i}`)!,
    );
    expect(n0.y + n0.height).toBeLessThan(n1.y);
    expect(n1.y + n1.height).toBeLessThan(n2.y);
    expect(n0.x).toBe(n1.x);
    expect(n0.customData.pitwall.direction).toBe("TB");
  });

  it("layout auto ignora x/y do skeleton (coordenadas velhas não colidem com o layout)", async () => {
    const skel = chain(2);
    const fresh = (await skeletonToElements(skel)) as AnyEl[];
    const stale = (await skeletonToElements(
      skel.map((s) =>
        s.type === "rectangle" ? { ...s, x: 5000, y: -900 } : s,
      ),
    )) as AnyEl[];
    const pos = (els: AnyEl[]) => els.map((e) => [e.id, e.x, e.y]);
    expect(pos(stale)).toEqual(pos(fresh));
    expect(fresh.find((e) => e.id === "n0")!.customData.pitwall.auto).toBe(
      true,
    );
  });

  it("text solto usa align left/top e containerId null", async () => {
    const elements = (await skeletonToElements(
      [{ id: "t1", type: "text", text: "nota", x: 10, y: 20 }],
      { layout: "keep" },
    )) as AnyEl[];
    expect(elements).toHaveLength(1);
    const t = elements[0];
    expect(t.textAlign).toBe("left");
    expect(t.verticalAlign).toBe("top");
    expect(t.containerId).toBeNull();
    expect(t.x).toBe(10);
    expect(t.y).toBe(20);
    // Coordenada explícita em "keep" = nó pinado.
    expect(t.customData.pitwall.auto).toBe(false);
  });

  it("respeita cores custom do skeleton", async () => {
    const elements = (await skeletonToElements([
      {
        id: "r",
        type: "rectangle",
        strokeColor: "#ff0000",
        backgroundColor: "#00ff00",
      },
    ])) as AnyEl[];
    expect(elements[0].strokeColor).toBe("#ff0000");
    expect(elements[0].backgroundColor).toBe("#00ff00");
  });
});

describe("elementsToSkeleton", () => {
  it("roundtrip preserva a semântica", async () => {
    const elements = await skeletonToElements(flowSkeleton);
    const back = elementsToSkeleton(elements);

    expect(back).toHaveLength(5);
    const byId = new Map(back.map((s) => [s.id, s]));
    expect(byId.get("start")!.type).toBe("ellipse");
    expect(byId.get("start")!.label).toEqual({ text: "Start" });
    expect(byId.get("work")!.type).toBe("rectangle");
    expect(byId.get("work")!.label).toEqual({ text: "Do work" });
    expect(byId.get("done")!.type).toBe("diamond");
    expect(byId.get("a1")!.start).toEqual({ id: "start" });
    expect(byId.get("a1")!.end).toEqual({ id: "work" });
    expect(byId.get("a1")!.label).toEqual({ text: "go" });
    expect(byId.get("a2")!.start).toEqual({ id: "work" });
    expect(byId.get("a2")!.end).toEqual({ id: "done" });
    // Cores default omitidas.
    expect(byId.get("work")!.strokeColor).toBeUndefined();
    expect(byId.get("work")!.backgroundColor).toBeUndefined();
  });

  it("ignora deletados e elementos fora do vocabulário", async () => {
    const elements = (await skeletonToElements([
      { id: "r", type: "rectangle" },
    ])) as AnyEl[];
    elements.push({ id: "sel", type: "selection", isDeleted: false });
    elements.push({ ...elements[0], id: "gone", isDeleted: true });
    const back = elementsToSkeleton(elements);
    expect(back.map((s) => s.id)).toEqual(["r"]);
  });

  it("inclui cores só quando diferentes do default e ordena por y,x", async () => {
    const elements = await skeletonToElements(
      [
        { id: "b", type: "rectangle", x: 0, y: 200, strokeColor: "#ff0000" },
        { id: "a", type: "rectangle", x: 0, y: 0 },
      ],
      { layout: "keep" },
    );
    const back = elementsToSkeleton(elements);
    // Sem geometria por padrão; includeGeometry devolve x/y/width/height.
    expect(back[0].x).toBeUndefined();
    expect(
      elementsToSkeleton(elements, { includeGeometry: true })[1],
    ).toMatchObject({
      x: 0,
      y: 200,
      width: 180,
      height: 70,
    });
    expect(back.map((s) => s.id)).toEqual(["a", "b"]);
    expect(back[0].strokeColor).toBeUndefined();
    expect(back[1].strokeColor).toBe("#ff0000");
  });
});

describe("applyPatch", () => {
  it("update muda só os campos citados e não altera os demais elementos", async () => {
    const elements = (await skeletonToElements(flowSkeleton)) as AnyEl[];
    const before = structuredClone(elements);
    const result = (await applyPatch(elements, [
      { op: "update", id: "work", x: 300, y: 50 },
    ])) as AnyEl[];

    // Imutável: array novo, input intocado.
    expect(result).not.toBe(elements);
    expect(elements).toEqual(before);

    const updated = result.find((e) => e.id === "work")!;
    const original = elements.find((e) => e.id === "work")!;
    expect(updated.x).toBe(300);
    expect(updated.y).toBe(50);
    expect(updated.version).toBe(original.version + 1);
    expect(updated.versionNonce).not.toBe(original.versionNonce);
    // Campos não citados preservados.
    expect(updated.width).toBe(original.width);
    expect(updated.strokeColor).toBe(original.strokeColor);

    // Label arrastado junto.
    const label = result.find((e) => e.id === "work__label")!;
    const labelBefore = elements.find((e) => e.id === "work__label")!;
    expect(label.x - labelBefore.x).toBe(300 - original.x);
    expect(label.y - labelBefore.y).toBe(50 - original.y);

    // x/y explícito pina o nó.
    expect(updated.customData.pitwall.auto).toBe(false);

    // Só as setas ligadas a "work" (e seus labels) são reroteadas; o resto
    // fica intacto (mesmas referências) — o ELK não move nada que já estava
    // no lugar.
    const rerouted = new Set([
      "work",
      "work__label",
      "a1",
      "a1__label",
      "a2",
      "a2__label",
    ]);
    for (const el of result) {
      if (rerouted.has(el.id)) continue;
      const orig = elements.find((e) => e.id === el.id)!;
      expect(el).toBe(orig);
    }
  });

  it("update de end religa a arrow: bindings, geometria e backlinks", async () => {
    const elements = await skeletonToElements(flowSkeleton);
    // a1 era start→work; religa pra start→done.
    const result = (await applyPatch(elements, [
      { op: "update", id: "a1", end: { id: "done" } },
    ])) as AnyEl[];

    const a1 = result.find((e) => e.id === "a1")!;
    expect(a1.startBinding).toMatchObject({
      elementId: "start",
      focus: 0,
      gap: 4,
    });
    expect(a1.endBinding).toMatchObject({
      elementId: "done",
      focus: 0,
      gap: 4,
    });

    // Geometria refeita borda-a-borda: o ponto final cai dentro do bbox
    // expandido do novo alvo, não do antigo.
    const done = result.find((e) => e.id === "done")!;
    const last = a1.points[a1.points.length - 1];
    const endX = a1.x + last[0];
    const endY = a1.y + last[1];
    expect(endX).toBeGreaterThanOrEqual(done.x - 1);
    expect(endX).toBeLessThanOrEqual(done.x + done.width + 1);
    expect(endY).toBeGreaterThanOrEqual(done.y - 1);
    expect(endY).toBeLessThanOrEqual(done.y + done.height + 1);

    // Backlinks: work perde a referência à a1, done ganha.
    const work = result.find((e) => e.id === "work")!;
    expect(work.boundElements.some((b: AnyEl) => b.id === "a1")).toBe(false);
    expect(done.boundElements.some((b: AnyEl) => b.id === "a1")).toBe(true);

    // Input intocado (imutabilidade preservada pelo rewire).
    const origA1 = (elements as AnyEl[]).find((e) => e.id === "a1")!;
    expect(origA1.endBinding).toMatchObject({
      elementId: "work",
      focus: 0,
      gap: 4,
    });
  });

  it("update de label.text reescreve o bound text e originalText", async () => {
    const elements = await skeletonToElements(flowSkeleton);
    const result = (await applyPatch(elements, [
      { op: "update", id: "work", label: { text: "New label" } },
    ])) as AnyEl[];
    const label = result.find((e) => e.id === "work__label")!;
    expect(label.text).toBe("New label");
    expect(label.originalText).toBe("New label");
  });

  it("delete marca isDeleted no elemento e label e limpa bindings alheios", async () => {
    const elements = await skeletonToElements(flowSkeleton);
    const result = (await applyPatch(elements, [{ op: "delete", id: "work" }], {
      layout: "keep",
    })) as AnyEl[];

    expect(result.find((e) => e.id === "work")!.isDeleted).toBe(true);
    expect(result.find((e) => e.id === "work__label")!.isDeleted).toBe(true);

    // Arrows que apontavam pro deletado perdem o binding correspondente.
    const a1 = result.find((e) => e.id === "a1")!;
    const a2 = result.find((e) => e.id === "a2")!;
    expect(a1.endBinding).toBeNull();
    expect(a1.startBinding).toMatchObject({
      elementId: "start",
      focus: 0,
      gap: 4,
    });
    expect(a2.startBinding).toBeNull();

    // Nenhum boundElements alheio referencia o deletado.
    for (const el of result) {
      if (el.id === "work") continue;
      for (const b of el.boundElements ?? []) {
        expect(b.id).not.toBe("work");
      }
    }
    // Elemento não relacionado permanece intocado.
    const done = result.find((e) => e.id === "done")!;
    expect(done).toBe((elements as AnyEl[]).find((e) => e.id === "done"));
  });

  it("add sem x/y não colide: vai abaixo do bounding box existente", async () => {
    const elements = await skeletonToElements(
      [
        { id: "a", type: "rectangle", x: 0, y: 0 },
        { id: "b", type: "rectangle", x: 300, y: 0 },
        { id: "c2", type: "rectangle", x: 0, y: 200 },
      ],
      { layout: "keep" },
    );
    const result = (await applyPatch(
      elements,
      [
        {
          op: "add",
          element: { id: "n", type: "rectangle", label: { text: "Novo" } },
        },
      ],
      { layout: "keep" },
    )) as AnyEl[];
    const added = result.find((e) => e.id === "n")!;
    // Abaixo do maxY (270) + 120.
    expect(added.y).toBe(390);
    // AABB disjoint de todos os nós pré-existentes.
    for (const el of result) {
      if (el.id === "n" || el.id === "n__label") continue;
      if (el.type === "arrow" || el.type === "line") continue;
      expect(disjoint(added, el)).toBe(true);
    }
    expect(result.find((e) => e.id === "n__label")).toBeDefined();
  });

  it("múltiplos adds no mesmo patch empilham lado a lado sem colidir", async () => {
    const elements = await skeletonToElements(
      [{ id: "a", type: "rectangle", x: 0, y: 0 }],
      { layout: "keep" },
    );
    const result = (await applyPatch(
      elements,
      [
        { op: "add", element: { id: "n1", type: "rectangle" } },
        { op: "add", element: { id: "n2", type: "rectangle" } },
      ],
      { layout: "keep" },
    )) as AnyEl[];
    const n1 = result.find((e) => e.id === "n1")!;
    const n2 = result.find((e) => e.id === "n2")!;
    expect(n1.y).toBe(190);
    expect(n2.y).toBe(n1.y);
    expect(n2.x).toBe(n1.x + n1.width + 80);
    expect(disjoint(n1, n2)).toBe(true);
    const a = result.find((e) => e.id === "a")!;
    expect(disjoint(n1, a)).toBe(true);
    expect(disjoint(n2, a)).toBe(true);
  });

  it("add ligado por seta fica perto do nó existente e sem sobreposição", async () => {
    const elements = await skeletonToElements(
      [{ id: "a", type: "rectangle", x: 0, y: 0 }],
      { layout: "keep" },
    );
    const result = (await applyPatch(
      elements,
      [
        {
          op: "add",
          element: { id: "c", type: "rectangle", label: { text: "Filho" } },
        },
        {
          op: "add",
          element: {
            id: "e1",
            type: "arrow",
            start: { id: "a" },
            end: { id: "c" },
          },
        },
      ],
      { layout: "keep" },
    )) as AnyEl[];
    const a = result.find((e) => e.id === "a")!;
    const c = result.find((e) => e.id === "c")!;
    expect(disjoint(a, c)).toBe(true);
    const dist = Math.hypot(
      c.x + c.width / 2 - (a.x + a.width / 2),
      c.y + c.height / 2 - (a.y + a.height / 2),
    );
    expect(dist).toBeLessThan(500);
    const arrow = result.find((e) => e.id === "e1")!;
    expect(arrow.startBinding).toMatchObject({
      elementId: "a",
      focus: 0,
      gap: 4,
    });
    expect(arrow.endBinding).toMatchObject({
      elementId: "c",
      focus: 0,
      gap: 4,
    });
  });

  it("add de arrow liga shapes existentes com bindings simétricos", async () => {
    const elements = await skeletonToElements(
      [
        { id: "a", type: "rectangle", x: 0, y: 0 },
        { id: "b", type: "rectangle", x: 400, y: 0 },
      ],
      { layout: "keep" },
    );
    const result = (await applyPatch(
      elements,
      [
        {
          op: "add",
          element: {
            id: "e1",
            type: "arrow",
            start: { id: "a" },
            end: { id: "b" },
          },
        },
      ],
      { layout: "keep" },
    )) as AnyEl[];
    const arrow = result.find((e) => e.id === "e1")!;
    expect(arrow.startBinding).toMatchObject({
      elementId: "a",
      focus: 0,
      gap: 4,
    });
    expect(arrow.endBinding).toMatchObject({
      elementId: "b",
      focus: 0,
      gap: 4,
    });
    expect(result.find((e) => e.id === "a")!.boundElements).toContainEqual({
      id: "e1",
      type: "arrow",
    });
    expect(result.find((e) => e.id === "b")!.boundElements).toContainEqual({
      id: "e1",
      type: "arrow",
    });
    // Seta borda-a-borda: começa na borda direita de 'a'.
    expect(arrow.x).toBe(180);
    expect(arrow.points[1][0]).toBe(220);
  });
});

describe("regressão: desalinhamento do auto-layout", () => {
  const fanOut: DiagramSkeletonElement[] = [
    { id: "p", type: "rectangle", label: { text: "Parent" } },
    { id: "c1", type: "rectangle", label: { text: "Child one" } },
    {
      id: "c2",
      type: "rectangle",
      label: { text: "Child two with a long label" },
    },
    { id: "c3", type: "rectangle", label: { text: "C3" } },
    { id: "e1", type: "arrow", start: { id: "p" }, end: { id: "c1" } },
    { id: "e2", type: "arrow", start: { id: "p" }, end: { id: "c2" } },
    { id: "e3", type: "arrow", start: { id: "p" }, end: { id: "c3" } },
  ];
  const cy = (e: AnyEl) => e.y + e.height / 2;
  const cx = (e: AnyEl) => e.x + e.width / 2;

  it("fan-out 1→3: centro do pai = centro médio dos filhos (±1px)", async () => {
    const els = (await skeletonToElements(fanOut)) as AnyEl[];
    const get = (id: string) => els.find((e) => e.id === id)!;
    const kids = ["c1", "c2", "c3"].map(get);
    const mean = kids.reduce((s, k) => s + cy(k), 0) / kids.length;
    expect(Math.abs(cy(get("p")) - mean)).toBeLessThanOrEqual(1);

    const tb = (await skeletonToElements(fanOut, {
      direction: "TB",
    })) as AnyEl[];
    const getTb = (id: string) => tb.find((e) => e.id === id)!;
    const meanX =
      ["c1", "c2", "c3"].map(getTb).reduce((s, k) => s + cx(k), 0) / 3;
    expect(Math.abs(cx(getTb("p")) - meanX)).toBeLessThanOrEqual(1);
  });

  it("largura do label sai da tabela da Excalifont, não de 0.6em por char", async () => {
    const els = (await skeletonToElements([
      { id: "r", type: "rectangle", label: { text: "Hello World" } },
    ])) as AnyEl[];
    const label = els.find((e) => e.id === "r__label")!;
    expect(label.width).toBeCloseTo(measureText("Hello World", 16).width, 6);
    expect(label.width).not.toBe(Math.round(0.6 * 16 * 11));
  });

  it("label fica centralizado no shape (rectangle, ellipse, diamond)", async () => {
    const els = (await skeletonToElements([
      {
        id: "r",
        type: "rectangle",
        label: { text: "Gate humano (aprovação)" },
      },
      { id: "o", type: "ellipse", label: { text: "Start" } },
      { id: "d", type: "diamond", label: { text: "Done?\nyes or no" } },
    ])) as AnyEl[];
    for (const id of ["r", "o", "d"]) {
      const shape = els.find((e) => e.id === id)!;
      const label = els.find((e) => e.id === `${id}__label`)!;
      expect(Math.abs(cx(label) - cx(shape))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(cy(label) - cy(shape))).toBeLessThanOrEqual(0.5);
    }
  });

  it("setas elbow: todos os segmentos são ortogonais e as pontas tocam os nós", async () => {
    const els = (await skeletonToElements(fanOut)) as AnyEl[];
    for (const id of ["e1", "e2", "e3"]) {
      const a = els.find((e) => e.id === id)!;
      expect(a.elbowed).toBe(true);
      expect(a.points[0]).toEqual([0, 0]);
      for (let i = 1; i < a.points.length; i++) {
        const [x0, y0] = a.points[i - 1];
        const [x1, y1] = a.points[i];
        expect(x0 === x1 || y0 === y1).toBe(true);
      }
      const end = els.find((e) => e.id === a.endBinding.elementId)!;
      const last = a.points[a.points.length - 1];
      // Entra pela borda esquerda do filho (LR).
      expect(a.x + last[0]).toBeCloseTo(end.x, 6);
      expect(a.endBinding.fixedPoint[0]).toBe(0);
    }
  });

  it("nó arrastado no editor vira pinado e o patch não o move", async () => {
    const els = (await skeletonToElements(fanOut)) as AnyEl[];
    const baseline = positionsOf(els);
    // Simula o arrasto do usuário em c2.
    const dragged = els.map((e) =>
      e.id === "c2" ? { ...e, x: e.x + 333, y: e.y + 222 } : e,
    );
    const pinned = pinMovedNodes(dragged, baseline) as AnyEl[];
    const c2 = pinned.find((e) => e.id === "c2")!;
    expect(c2.customData.pitwall.auto).toBe(false);
    expect(pinMovedNodes(els, baseline)).toBe(els);

    const result = (await applyPatch(pinned, [
      {
        op: "add",
        element: { id: "c4", type: "rectangle", label: { text: "C4" } },
      },
      {
        op: "add",
        element: {
          id: "e4",
          type: "arrow",
          start: { id: "p" },
          end: { id: "c4" },
        },
      },
    ])) as AnyEl[];
    const after = result.find((e) => e.id === "c2")!;
    expect([after.x, after.y]).toEqual([c2.x, c2.y]);
    // Seta pro nó pinado foi reroteada até ele (rota própria, ortogonal).
    const e2 = result.find((e) => e.id === "e2")!;
    const last = e2.points[e2.points.length - 1];
    const endX = e2.x + last[0];
    const endY = e2.y + last[1];
    expect(endX).toBeGreaterThanOrEqual(after.x - 0.5);
    expect(endX).toBeLessThanOrEqual(after.x + after.width + 0.5);
    expect(endY).toBeGreaterThanOrEqual(after.y - 0.5);
    expect(endY).toBeLessThanOrEqual(after.y + after.height + 0.5);
    // O nó novo entrou na camada dos filhos (auto) e o pai segue centralizado
    // entre os filhos auto do layout.
    const c4 = result.find((e) => e.id === "c4")!;
    expect(c4.customData.pitwall.auto).toBe(true);
    expect(c4.x).toBe(result.find((e) => e.id === "c1")!.x);
  });

  it("layout keep: nenhum nó existente se move no patch", async () => {
    const els = (await skeletonToElements(fanOut)) as AnyEl[];
    const result = (await applyPatch(els, [{ op: "delete", id: "c2" }], {
      layout: "keep",
    })) as AnyEl[];
    for (const id of ["p", "c1", "c3"]) {
      const before = els.find((e) => e.id === id)!;
      const after = result.find((e) => e.id === id)!;
      expect([after.x, after.y]).toEqual([before.x, before.y]);
    }
  });

  it("patch com x/y pina o nó e um patch seguinte não o devolve ao layout", async () => {
    const els = (await skeletonToElements(fanOut)) as AnyEl[];
    const moved = (await applyPatch(els, [
      { op: "update", id: "c1", x: 1200, y: 40 },
    ])) as AnyEl[];
    const again = (await applyPatch(moved, [
      { op: "update", id: "c3", label: { text: "C3 renamed" } },
    ])) as AnyEl[];
    const c1 = again.find((e) => e.id === "c1")!;
    expect([c1.x, c1.y]).toEqual([1200, 40]);
    expect(c1.customData.pitwall.auto).toBe(false);
  });
});
