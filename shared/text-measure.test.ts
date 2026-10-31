import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXCALIFONT_FONT_HASH } from "./excalifont-metrics";
import { advanceOf, measureText } from "./text-measure";

const FONT_DIR = join(
  __dirname,
  "../node_modules/@excalidraw/excalidraw/dist/prod/fonts/Excalifont",
);

describe("excalifont metrics", () => {
  it("tabela gerada bate com os woff2 instalados (rode scripts/gen-excalifont-metrics.mjs se falhar)", () => {
    const h = createHash("sha256");
    for (const f of readdirSync(FONT_DIR)
      .filter((f) => f.endsWith(".woff2"))
      .sort()) {
      h.update(f);
      h.update(readFileSync(join(FONT_DIR, f)));
    }
    expect(h.digest("hex")).toBe(EXCALIFONT_FONT_HASH);
  });

  it("largura é a soma dos advances da tabela", () => {
    const text = "Hello World";
    const units = [...text].reduce(
      (s, c) => s + advanceOf(c.codePointAt(0)!),
      0,
    );
    expect(measureText(text, 16).width).toBeCloseTo((units * 16) / 1000, 6);
    // Fonte proporcional: "i" é bem mais estreito que "W".
    expect(advanceOf(105)).toBeLessThan(advanceOf(87));
  });

  it("altura = linhas × fontSize × 1.25; largura = linha mais larga", () => {
    const m = measureText("ab\nlonger line", 20);
    expect(m.height).toBe(2 * 20 * 1.25);
    expect(m.width).toBe(measureText("longer line", 20).width);
  });
});
