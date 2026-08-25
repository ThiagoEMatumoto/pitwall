// UNICO ponto de contato do video com o design system do app. Nada aqui pode
// importar Remotion nem React: theme.check.ts depende disso pra servir de
// sentinela (ver comentario la).
import {
  DEFAULT_PRESET_ID,
  getPreset,
  PRESETS,
  type ThemePreset,
  type ThemeTokenKey,
  type ThemeTokens,
} from '../../src/lib/themes.ts'

export {DEFAULT_PRESET_ID, getPreset, PRESETS}
export type {ThemePreset, ThemeTokenKey, ThemeTokens}

/** Tokens do tema "Vacuo" — a mesma fonte de verdade que o app usa em runtime. */
export const vacuo: ThemeTokens = getPreset(DEFAULT_PRESET_ID).tokens

/** Alias historico; `vacuo` e o nome canonico. */
export const tokens: ThemeTokens = vacuo

/**
 * Cores da marca que NAO vivem no preset de tema: sao do logo (barras do muro)
 * e do gradiente do Apice. Ficam aqui pra que nenhum componente hardcode hex.
 */
export const BRAND = {
  /** Barras do muro de boxes — pitwall-logo.svg */
  bar: '#e9e7f4',
  /** Gradiente do Apice: ciano -> roxo */
  apexFrom: vacuo.accent2,
  apexTo: vacuo.accent,
} as const

/** rgba() a partir de um token hex — util pra sombras/glow sem novo hardcode. */
export const alpha = (hex: string, a: number): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${a})`
}
