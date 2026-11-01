import { describe, expect, it, vi } from "vitest";
import { skeletonToElements } from "../../../electron/main/services/diagram-layout";
import { RESTORE_OPTS, restoreSceneElements } from "./restore-scene";

type AnyEl = Record<string, any>;

const sizesOfTexts = (elements: AnyEl[]) =>
  elements
    .filter((el) => el.type === "text")
    .map((el) => ({ id: el.id, width: el.width, height: el.height }));

// Imita o restoreElements do Excalidraw: com refreshDimensions ele remede o
// texto; antes de a Excalifont carregar, a fonte de fallback é mais estreita.
const fallbackFontRestore = vi.fn(
  (elements: AnyEl[], _local: unknown, opts?: { refreshDimensions?: boolean }) =>
    elements.map((el) =>
      opts?.refreshDimensions && el.type === "text"
        ? { ...el, width: el.width * 0.82, height: el.height * 0.9 }
        : el,
    ),
);

describe("restoreSceneElements", () => {
  it("não pede ao Excalidraw para remedir o texto no restore", () => {
    const restore = vi.fn(() => []);
    restoreSceneElements({ restoreElements: restore as never }, []);
    expect(restore).toHaveBeenCalledWith([], null, RESTORE_OPTS);
    expect(RESTORE_OPTS).not.toHaveProperty("refreshDimensions");
    expect(RESTORE_OPTS.repairBindings).toBe(true);
  });

  // Regressão: o label 'Serviço de autenticação' abria com 152 de largura em
  // vez de 186 na primeira abertura da sessão.
  it("preserva width/height dos textos que o skeleton produziu", async () => {
    const elements = (await skeletonToElements([
      { id: "api", type: "rectangle", label: { text: "API Gateway" } },
      { id: "auth", type: "rectangle", label: { text: "Serviço de autenticação" } },
      { id: "e1", type: "arrow", start: { id: "api" }, end: { id: "auth" } },
    ])) as AnyEl[];
    const before = sizesOfTexts(elements);
    expect(before.length).toBeGreaterThan(0);

    const restored = restoreSceneElements(
      { restoreElements: fallbackFontRestore as never },
      elements,
    ) as unknown as AnyEl[];

    expect(sizesOfTexts(restored)).toEqual(before);
  });
});
