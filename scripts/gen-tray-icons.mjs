// Gera os PNGs do ícone de tray (22 px + @2x 44 px) a partir do glifo do Pitwall
// em build/icon.svg — as duas barras + o círculo, em monocromático claro e sem o
// fundo preto — com um badge circular no canto inferior direito por estado.
// Saída: electron/main/services/meetings/tray-icons.generated.ts (commitável).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outPath = join(root, 'electron/main/services/meetings/tray-icons.generated.ts')

const GLYPH_COLOR = '#e9e7f4'
const FRAME = 44
// Glifo do icon.svg (coordenadas do <g>): barras de x=4 a x=40, centro em (22,22).
const GLYPH_WIDTH = 36
const GLYPH_CENTER = 22
const GLYPH_FILL_RATIO = 0.8
const BADGE_RATIO = 0.4
const BADGE_MARGIN = 0.5

const STATES = {
  idle: null,
  recording: { color: '#e5484d', opacity: 1 },
  recordingDim: { color: '#e5484d', opacity: 0.45 },
  detected: { color: '#f5a524', opacity: 1 },
}

function svgFor(badge) {
  const k = (FRAME * GLYPH_FILL_RATIO) / GLYPH_WIDTH
  const t = FRAME / 2 - GLYPH_CENTER * k
  const r = (FRAME * BADGE_RATIO) / 2
  const c = FRAME - r - BADGE_MARGIN
  const badgeEl = badge
    ? `<circle cx="${c}" cy="${c}" r="${r}" fill="${badge.color}" fill-opacity="${badge.opacity}"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FRAME} ${FRAME}" width="${FRAME}" height="${FRAME}">
  <g transform="translate(${t} ${t}) scale(${k})" fill="${GLYPH_COLOR}">
    <rect x="4" y="19.5" width="11.5" height="5" rx="2.5"/>
    <rect x="28.5" y="19.5" width="11.5" height="5" rx="2.5"/>
    <circle cx="22" cy="22" r="3.4"/>
  </g>
  ${badgeEl}
</svg>`
}

function renderBase64(svg, size) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
  return resvg.render().asPng().toString('base64')
}

const entries = Object.entries(STATES).map(([name, badge]) => {
  const svg = svgFor(badge)
  return `  ${name}: {\n    x1: '${renderBase64(svg, 22)}',\n    x2: '${renderBase64(svg, 44)}',\n  },`
})

const source = `// gerado por scripts/gen-tray-icons.mjs — não editar
// Fonte: build/icon.svg (glifo) + badge por estado. Regerar: npm run gen:tray-icons
export type TrayIconKind = 'idle' | 'recording' | 'recordingDim' | 'detected'

export const TRAY_ICON_PNG: Record<TrayIconKind, { x1: string; x2: string }> = {
${entries.join('\n')}
}
`

const previous = (() => {
  try {
    return readFileSync(outPath, 'utf8')
  } catch {
    return null
  }
})()
if (previous === source) {
  console.log(`${outPath}: sem mudanças`)
} else {
  writeFileSync(outPath, source)
  console.log(outPath)
}
