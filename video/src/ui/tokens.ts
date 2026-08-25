// Ponte entre o design system (src/theme.ts, src/fonts.ts) e os componentes de
// chrome. Nenhum hex mora aqui: `vacuo` vem do MESMO preset que o app usa em
// runtime, então mudar o tema no app muda o vídeo. O que este módulo acrescenta
// é só ergonomia — chaves em camelCase, porque `C['surface-2']` no meio de um
// style inline é ruído.

import { BRAND, alpha as themeAlpha, vacuo } from "../theme";
// Importar fonts.ts também dispara o carregamento das faces (o módulo chama
// loadPitwallFonts() no topo), o que segura o frame até Schibsted e JetBrains
// estarem prontas — sem isso a métrica do texto sai errada em silêncio.
import { FONT_DISPLAY, FONT_MONO } from "../fonts";

export const C = {
  bg: vacuo.bg,
  surface: vacuo.surface,
  surface2: vacuo["surface-2"],
  border: vacuo.border,
  accent: vacuo.accent,
  accentDim: vacuo["accent-dim"],
  accent2: vacuo.accent2,
  text: vacuo.text,
  textDim: vacuo["text-dim"],
  success: vacuo.success,
  warning: vacuo.warning,
  danger: vacuo.danger,
  info: vacuo.info,
  /** Barras do muro de boxes, no logo. */
  brandBar: BRAND.bar,
} as const;

export const DISPLAY = FONT_DISPLAY;
export const MONO = FONT_MONO;

/** Gradiente d'"O Ápice": ciano → violeta, o mesmo do círculo do logo. */
export const GRADIENT_BRAND = `linear-gradient(135deg, ${BRAND.apexFrom}, ${BRAND.apexTo})`;

export const alpha = themeAlpha;

/** Mistura hex sobre hex — substituto de color-mix(), que o render não resolve. */
export function mix(fg: string, bg: string, pct: number): string {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  const t = Math.max(0, Math.min(1, pct));
  const ch = (i: 0 | 1 | 2) => Math.round(f[i] * t + b[i] * (1 - t));
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}
