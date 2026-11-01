import { describe, expect, it } from "vitest";
import { frameViewport, VIEWPORT_TOP_INSET } from "./frame-viewport";

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
    expect(v.zoom).toBeCloseTo((0.85 * viewport.width) / 4000);
    expect(screenSpan(b, v).top).toBeGreaterThanOrEqual(VIEWPORT_TOP_INSET);
  });
});
