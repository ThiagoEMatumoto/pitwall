import { describe, expect, it } from "vitest";
import {
  applyPatch,
  elementsToSkeleton,
  skeletonToElements,
  type DiagramSkeletonElement,
} from "./diagram-skeleton";

type AnyEl = Record<string, any>;

/** Remove campos não-determinísticos pra comparação estrutural. */
function normalize(elements: unknown[]): AnyEl[] {
  return (elements as AnyEl[]).map((el) => {
    const { seed, versionNonce, updated, ...rest } = el;
    return rest;
  });
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
  it("golden: 3 nós + 2 setas com labels (snapshot estrutural)", () => {
    const elements = skeletonToElements(flowSkeleton);
    expect(normalize(elements)).toMatchSnapshot();
  });

  it("gera elementos completos e válidos", () => {
    const elements = skeletonToElements(flowSkeleton) as AnyEl[];
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
    expect(arrow.roundness).toEqual({ type: 2 });
    expect(arrow.elbowed).toBe(false);
    expect(arrow.startArrowhead).toBeNull();
    expect(arrow.endArrowhead).toBe("arrow");
    expect(arrow.lastCommittedPoint).toBeNull();
    expect(arrow.points[0]).toEqual([0, 0]);

    // Índices fracionais crescentes.
    const indexes = elements.map((e) => e.index);
    expect([...indexes].sort()).toEqual(indexes);
  });

  it("labels viram text bound com containerId e boundElements no dono", () => {
    const elements = skeletonToElements(flowSkeleton) as AnyEl[];
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

  it("bindings são simétricos entre arrow e shapes", () => {
    const elements = skeletonToElements(flowSkeleton) as AnyEl[];
    const arrow = elements.find((e) => e.id === "a1")!;
    expect(arrow.startBinding).toEqual({
      elementId: "start",
      focus: 0,
      gap: 4,
    });
    expect(arrow.endBinding).toEqual({ elementId: "work", focus: 0, gap: 4 });

    const start = elements.find((e) => e.id === "start")!;
    const work = elements.find((e) => e.id === "work")!;
    expect(start.boundElements).toContainEqual({ id: "a1", type: "arrow" });
    expect(work.boundElements).toContainEqual({ id: "a1", type: "arrow" });
    expect(work.boundElements).toContainEqual({ id: "a2", type: "arrow" });
  });

  it("auto-layout é determinístico e em camadas topológicas", () => {
    const first = skeletonToElements(flowSkeleton) as AnyEl[];
    const second = skeletonToElements(flowSkeleton) as AnyEl[];
    const pos = (els: AnyEl[]) =>
      els.map((e) => ({ id: e.id, x: e.x, y: e.y, points: e.points ?? null }));
    expect(pos(first)).toEqual(pos(second));

    const start = first.find((e) => e.id === "start")!;
    const work = first.find((e) => e.id === "work")!;
    const done = first.find((e) => e.id === "done")!;
    expect(start.x).toBe(0);
    expect(work.x).toBe(260);
    expect(done.x).toBe(520);
  });

  it("text solto usa align left/top e containerId null", () => {
    const elements = skeletonToElements([
      { id: "t1", type: "text", text: "nota", x: 10, y: 20 },
    ]) as AnyEl[];
    expect(elements).toHaveLength(1);
    const t = elements[0];
    expect(t.textAlign).toBe("left");
    expect(t.verticalAlign).toBe("top");
    expect(t.containerId).toBeNull();
    expect(t.x).toBe(10);
    expect(t.y).toBe(20);
  });

  it("respeita cores custom do skeleton", () => {
    const elements = skeletonToElements([
      {
        id: "r",
        type: "rectangle",
        strokeColor: "#ff0000",
        backgroundColor: "#00ff00",
      },
    ]) as AnyEl[];
    expect(elements[0].strokeColor).toBe("#ff0000");
    expect(elements[0].backgroundColor).toBe("#00ff00");
  });
});

describe("elementsToSkeleton", () => {
  it("roundtrip preserva a semântica", () => {
    const elements = skeletonToElements(flowSkeleton);
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

  it("ignora deletados e elementos fora do vocabulário", () => {
    const elements = skeletonToElements([
      { id: "r", type: "rectangle" },
    ]) as AnyEl[];
    elements.push({ id: "sel", type: "selection", isDeleted: false });
    elements.push({ ...elements[0], id: "gone", isDeleted: true });
    const back = elementsToSkeleton(elements);
    expect(back.map((s) => s.id)).toEqual(["r"]);
  });

  it("inclui cores só quando diferentes do default e ordena por y,x", () => {
    const elements = skeletonToElements([
      { id: "b", type: "rectangle", x: 0, y: 200, strokeColor: "#ff0000" },
      { id: "a", type: "rectangle", x: 0, y: 0 },
    ]);
    const back = elementsToSkeleton(elements);
    expect(back.map((s) => s.id)).toEqual(["a", "b"]);
    expect(back[0].strokeColor).toBeUndefined();
    expect(back[1].strokeColor).toBe("#ff0000");
  });
});

describe("applyPatch", () => {
  it("update muda só os campos citados e não altera os demais elementos", () => {
    const elements = skeletonToElements(flowSkeleton) as AnyEl[];
    const before = structuredClone(elements);
    const result = applyPatch(elements, [
      { op: "update", id: "work", x: 300, y: 50 },
    ]) as AnyEl[];

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

    // Todos os outros elementos intactos (deep-equal, mesmas referências).
    for (const el of result) {
      if (el.id === "work" || el.id === "work__label") continue;
      const orig = elements.find((e) => e.id === el.id)!;
      expect(el).toBe(orig);
    }
  });

  it("update de label.text reescreve o bound text e originalText", () => {
    const elements = skeletonToElements(flowSkeleton);
    const result = applyPatch(elements, [
      { op: "update", id: "work", label: { text: "New label" } },
    ]) as AnyEl[];
    const label = result.find((e) => e.id === "work__label")!;
    expect(label.text).toBe("New label");
    expect(label.originalText).toBe("New label");
  });

  it("delete marca isDeleted no elemento e label e limpa bindings alheios", () => {
    const elements = skeletonToElements(flowSkeleton);
    const result = applyPatch(elements, [
      { op: "delete", id: "work" },
    ]) as AnyEl[];

    expect(result.find((e) => e.id === "work")!.isDeleted).toBe(true);
    expect(result.find((e) => e.id === "work__label")!.isDeleted).toBe(true);

    // Arrows que apontavam pro deletado perdem o binding correspondente.
    const a1 = result.find((e) => e.id === "a1")!;
    const a2 = result.find((e) => e.id === "a2")!;
    expect(a1.endBinding).toBeNull();
    expect(a1.startBinding).toEqual({ elementId: "start", focus: 0, gap: 4 });
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

  it("add sem x/y posiciona perto do centro de massa existente", () => {
    const elements = skeletonToElements([
      { id: "a", type: "rectangle", x: 0, y: 0 },
      { id: "b", type: "rectangle", x: 200, y: 200 },
    ]);
    const result = applyPatch(elements, [
      {
        op: "add",
        element: { id: "c", type: "rectangle", label: { text: "C" } },
      },
    ]) as AnyEl[];
    const added = result.find((e) => e.id === "c")!;
    // Centro de massa: (190, 135) → perto disso.
    expect(Math.abs(added.x - 190)).toBeLessThan(100);
    expect(Math.abs(added.y - 135)).toBeLessThan(100);
    expect(result.find((e) => e.id === "c__label")).toBeDefined();
  });

  it("add de arrow liga shapes existentes com bindings simétricos", () => {
    const elements = skeletonToElements([
      { id: "a", type: "rectangle", x: 0, y: 0 },
      { id: "b", type: "rectangle", x: 400, y: 0 },
    ]);
    const result = applyPatch(elements, [
      {
        op: "add",
        element: {
          id: "e1",
          type: "arrow",
          start: { id: "a" },
          end: { id: "b" },
        },
      },
    ]) as AnyEl[];
    const arrow = result.find((e) => e.id === "e1")!;
    expect(arrow.startBinding).toEqual({ elementId: "a", focus: 0, gap: 4 });
    expect(arrow.endBinding).toEqual({ elementId: "b", focus: 0, gap: 4 });
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
