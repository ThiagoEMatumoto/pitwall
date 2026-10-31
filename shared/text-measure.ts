// Medição de texto Excalifont sem DOM: soma dos advances da tabela gerada a
// partir dos woff2 do Excalidraw. Roda igual no main e no renderer.
import {
  EXCALIFONT_ADVANCE_RUNS,
  EXCALIFONT_UNITS_PER_EM,
} from "./excalifont-metrics";

export const EXCALIFONT_LINE_HEIGHT = 1.25;

const advanceByCodepoint = new Map<number, number>();
for (const run of EXCALIFONT_ADVANCE_RUNS) {
  for (let i = 1; i < run.length; i++) {
    advanceByCodepoint.set(run[0] + i - 1, run[i]);
  }
}

// Codepoint fora dos subsets (emoji, CJK) cai pra fonte de fallback do
// browser, que desenha esses glyphs com ~1em. Superestimar só sobra folga no
// box; a média latina (~0,58em) fazia o label transbordar.
const FALLBACK_ADVANCE = EXCALIFONT_UNITS_PER_EM;

// ZWJ e seletores de variação compõem o glyph anterior, sem largura própria.
const isZeroWidth = (cp: number) =>
  cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f);

export function advanceOf(codepoint: number): number {
  const known = advanceByCodepoint.get(codepoint);
  if (known !== undefined) return known;
  return isZeroWidth(codepoint) ? 0 : FALLBACK_ADVANCE;
}

export function measureLine(line: string, fontSize: number): number {
  let units = 0;
  for (const ch of line) units += advanceOf(ch.codePointAt(0)!);
  return (units * fontSize) / EXCALIFONT_UNITS_PER_EM;
}

/** Caixa do texto como o Excalidraw mede: linha mais larga × N linhas. */
export function measureText(
  text: string,
  fontSize: number,
  lineHeight = EXCALIFONT_LINE_HEIGHT,
): { width: number; height: number } {
  const lines = text.split("\n");
  const width = lines.reduce(
    (m, l) => Math.max(m, measureLine(l, fontSize)),
    0,
  );
  return { width, height: lines.length * fontSize * lineHeight };
}
