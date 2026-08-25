/**
 * Sentinela: importa o modulo de tema e imprime um token.
 *
 * Serve pra quebrar CEDO (e barulhento) se `src/lib/themes.ts` do app deixar de
 * ser TS puro — hoje ele nao tem nenhum import, e e exatamente por isso que o
 * video consegue consumi-lo direto. No dia em que ganhar um `import` de React,
 * de CSS ou de algum modulo do Electron, este arquivo para de rodar fora do
 * bundler e denuncia o acoplamento antes que o render quebre.
 *
 * Rodar: npm run check:theme
 */
import {BRAND, DEFAULT_PRESET_ID, PRESETS, vacuo} from './theme.ts'

const lines = [
  `preset default : ${DEFAULT_PRESET_ID}`,
  `presets        : ${PRESETS.map((p) => p.id).join(', ')}`,
  `vacuo.bg       : ${vacuo.bg}`,
  `vacuo.accent   : ${vacuo.accent}`,
  `vacuo.accent2  : ${vacuo.accent2}`,
  `brand.bar      : ${BRAND.bar}`,
]

console.log(lines.join('\n'))

if (vacuo.bg !== '#08080B' || vacuo.accent !== '#9D8CFF') {
  console.error('theme.check: tokens do Vacuo mudaram — confira o video antes de renderizar.')
  process.exit(1)
}
