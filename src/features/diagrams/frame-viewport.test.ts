import { describe, expect, it } from "vitest";
import {
  contentBounds,
  frameViewport,
  VIEWPORT_TOP_INSET,
} from "./frame-viewport";

// Topo/base do conteúdo em coordenadas de tela.
function screenSpan(
  b: { minY: number; maxY: number },
  v: { scrollY: number; zoom: number },
) {
  return {
    top: (b.minY + v.scrollY) * v.zoom,
    bottom: (b.maxY + v.scrollY) * v.zoom,
  };
}

describe("frameViewport", () => {
  const viewport = { width: 1200, height: 700 };

  it("ER alto: o topo do conteúdo abre abaixo da toolbar, base dentro da tela", () => {
    const b = { minX: 0, minY: 0, maxX: 900, maxY: 1400 };
    const v = frameViewport(b, viewport);
    const { top, bottom } = screenSpan(b, v);
    expect(top).toBeGreaterThanOrEqual(VIEWPORT_TOP_INSET);
    expect(bottom).toBeLessThanOrEqual(viewport.height);
  });

  it("cena pequena: zoom não passa de 100% e continua abaixo da toolbar", () => {
    const b = { minX: 100, minY: 50, maxX: 300, maxY: 120 };
    const v = frameViewport(b, viewport);
    expect(v.zoom).toBe(1);
    expect(screenSpan(b, v).top).toBeGreaterThanOrEqual(VIEWPORT_TOP_INSET);
    // Centralizado na horizontal.
    expect((b.minX + v.scrollX) * v.zoom + (b.maxX - b.minX) / 2).toBeCloseTo(
      viewport.width / 2,
    );
  });

  it("cena larga e baixa: o limite é a largura, ainda abaixo da toolbar", () => {
    const b = { minX: 0, minY: 0, maxX: 4000, maxY: 200 };
    const v = frameViewport(b, viewport);
    expect(v.zoom).toBeCloseTo((0.9 * viewport.width) / 4000);
    expect(screenSpan(b, v).top).toBeGreaterThanOrEqual(VIEWPORT_TOP_INSET);
  });

  it("centraliza o conteúdo na área útil abaixo da toolbar", () => {
    const b = { minX: -300, minY: 40, maxX: 1700, maxY: 600 };
    const v = frameViewport(b, viewport);
    const cx = ((b.minX + b.maxX) / 2 + v.scrollX) * v.zoom;
    const cy = ((b.minY + b.maxY) / 2 + v.scrollY) * v.zoom;
    expect(cx).toBeCloseTo(viewport.width / 2);
    expect(cy).toBeCloseTo(
      VIEWPORT_TOP_INSET + (viewport.height - VIEWPORT_TOP_INSET) / 2,
    );
  });
});

describe("contentBounds", () => {
  it("seta que volta pra esquerda conta pelos pontos, não por x + width", () => {
    const b = contentBounds([
      { type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
      { type: "rectangle", x: 500, y: 0, width: 100, height: 50 },
      // x = 1º ponto (borda direita do nó da direita), volta até x = 0.
      {
        type: "arrow",
        x: 600,
        y: 25,
        width: 600,
        height: 75,
        points: [
          [0, 0],
          [0, 75],
          [-600, 75],
          [-600, 0],
        ],
      },
    ]);
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 600, maxY: 100 });
  });

  it("inclui o nome do frame acima da caixa e ignora deletados", () => {
    const b = contentBounds([
      { type: "frame", x: 0, y: 100, width: 300, height: 200 },
      { type: "rectangle", x: 5000, y: 0, width: 1, height: 1, isDeleted: true },
    ]);
    expect(b!.minY).toBeLessThan(100);
    expect(b!.maxX).toBe(300);
    expect(contentBounds([])).toBeNull();
  });
});
