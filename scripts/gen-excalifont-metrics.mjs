#!/usr/bin/env node
// Gera shared/excalifont-metrics.ts: advance width por codepoint da Excalifont,
// lido direto dos woff2 que o @excalidraw/excalidraw distribui. Sem dependência
// nova: WOFF2 = diretório de tabelas + um único stream brotli.
//
// Uso: node scripts/gen-excalifont-metrics.mjs
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const FONT_DIR = join(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts/Excalifont')
const OUT = join(root, 'shared/excalifont-metrics.ts')

// Ordem da spec WOFF2 (5.1, "Known Table Tags").
const KNOWN_TAGS = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
]

function readBase128(buf, pos) {
  let value = 0
  for (let i = 0; i < 5; i++) {
    const byte = buf[pos.at++]
    value = value * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) return value
  }
  throw new Error('UIntBase128 inválido')
}

/** Tabelas descomprimidas (ainda no formato transformado, se houver). */
function woff2Tables(buf) {
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error('não é WOFF2')
  const numTables = buf.readUInt16BE(12)
  const compressedSize = buf.readUInt32BE(20)
  const pos = { at: 48 }
  const dir = []
  for (let i = 0; i < numTables; i++) {
    const flags = buf[pos.at++]
    let tag
    if ((flags & 0x3f) === 0x3f) {
      tag = buf.toString('latin1', pos.at, pos.at + 4)
      pos.at += 4
    } else {
      tag = KNOWN_TAGS[flags & 0x3f]
    }
    const transformVersion = flags >> 6
    const origLength = readBase128(buf, pos)
    const transformed =
      tag === 'glyf' || tag === 'loca' ? transformVersion === 0 : transformVersion !== 0
    const length = transformed ? readBase128(buf, pos) : origLength
    dir.push({ tag, transformed, length })
  }
  const data = brotliDecompressSync(buf.subarray(pos.at, pos.at + compressedSize))
  const tables = new Map()
  let offset = 0
  for (const t of dir) {
    tables.set(t.tag, { ...t, data: data.subarray(offset, offset + t.length) })
    offset += t.length
  }
  return tables
}

function parseCmap(cmap) {
  const n = cmap.readUInt16BE(2)
  const subtables = []
  for (let i = 0; i < n; i++) {
    const base = 4 + i * 8
    subtables.push({
      platform: cmap.readUInt16BE(base),
      encoding: cmap.readUInt16BE(base + 2),
      offset: cmap.readUInt32BE(base + 4),
    })
  }
  const map = new Map()
  for (const st of subtables) {
    const format = cmap.readUInt16BE(st.offset)
    if (format === 12) {
      const groups = cmap.readUInt32BE(st.offset + 12)
      for (let g = 0; g < groups; g++) {
        const b = st.offset + 16 + g * 12
        const start = cmap.readUInt32BE(b)
        const end = cmap.readUInt32BE(b + 4)
        const gid = cmap.readUInt32BE(b + 8)
        for (let cp = start; cp <= end; cp++) map.set(cp, gid + cp - start)
      }
    } else if (format === 4) {
      const o = st.offset
      const segX2 = cmap.readUInt16BE(o + 6)
      const ends = o + 14
      const starts = ends + segX2 + 2
      const deltas = starts + segX2
      const ranges = deltas + segX2
      for (let s = 0; s < segX2 / 2; s++) {
        const end = cmap.readUInt16BE(ends + s * 2)
        const start = cmap.readUInt16BE(starts + s * 2)
        const delta = cmap.readInt16BE(deltas + s * 2)
        const rangeOffset = cmap.readUInt16BE(ranges + s * 2)
        for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
          let gid
          if (rangeOffset === 0) {
            gid = (cp + delta) & 0xffff
          } else {
            const at = ranges + s * 2 + rangeOffset + (cp - start) * 2
            gid = cmap.readUInt16BE(at)
            if (gid !== 0) gid = (gid + delta) & 0xffff
          }
          if (gid !== 0 && !map.has(cp)) map.set(cp, gid)
        }
      }
    }
  }
  return map
}

/**
 * Advances por glyph. hmtx transformado (versão 1 da spec) começa com 1 byte
 * de flags seguido do mesmo array advanceWidth[numberOfHMetrics] do formato
 * normal — só os lsb é que somem, e eles não importam pra medir largura.
 */
function advances(tables) {
  const hhea = tables.get('hhea').data
  const numberOfHMetrics = hhea.readUInt16BE(34)
  const hmtx = tables.get('hmtx')
  const start = hmtx.transformed ? 1 : 0
  const stride = hmtx.transformed ? 2 : 4
  const out = []
  for (let i = 0; i < numberOfHMetrics; i++) {
    out.push(hmtx.data.readUInt16BE(start + i * stride))
  }
  return out
}

export function fontFiles() {
  return readdirSync(FONT_DIR)
    .filter((f) => f.endsWith('.woff2'))
    .sort()
}

/** Hash estável do conjunto de woff2 (detecta troca de fonte no upgrade). */
export function fontHash() {
  const h = createHash('sha256')
  for (const f of fontFiles()) {
    h.update(f)
    h.update(readFileSync(join(FONT_DIR, f)))
  }
  return h.digest('hex')
}

function extract() {
  let unitsPerEm = null
  const byCodepoint = new Map()
  for (const f of fontFiles()) {
    const tables = woff2Tables(readFileSync(join(FONT_DIR, f)))
    const upm = tables.get('head').data.readUInt16BE(18)
    if (unitsPerEm !== null && upm !== unitsPerEm) {
      throw new Error(`unitsPerEm divergente entre subsets: ${upm} vs ${unitsPerEm}`)
    }
    unitsPerEm = upm
    const adv = advances(tables)
    for (const [cp, gid] of parseCmap(tables.get('cmap').data)) {
      byCodepoint.set(cp, adv[Math.min(gid, adv.length - 1)])
    }
  }
  return { unitsPerEm, byCodepoint }
}

/** Runs contíguos [codepoint inicial, advances...] pra manter o arquivo curto. */
function toRuns(byCodepoint) {
  const cps = [...byCodepoint.keys()].sort((a, b) => a - b)
  const runs = []
  for (const cp of cps) {
    const last = runs[runs.length - 1]
    if (last && last[0] + last.length - 1 === cp) last.push(byCodepoint.get(cp))
    else runs.push([cp, byCodepoint.get(cp)])
  }
  return runs
}

function main() {
  const { unitsPerEm, byCodepoint } = extract()
  const runs = toRuns(byCodepoint)
  const body = runs.map((r) => `  [${r.join(',')}],`).join('\n')
  const content = `// GERADO por scripts/gen-excalifont-metrics.mjs — não editar à mão.
// Advance widths da Excalifont (subsets woff2 do @excalidraw/excalidraw).
// Cada run: [codepoint inicial, advance do cp, advance do cp+1, ...].

export const EXCALIFONT_FONT_HASH =
  "${fontHash()}";
export const EXCALIFONT_UNITS_PER_EM = ${unitsPerEm};
export const EXCALIFONT_GLYPH_COUNT = ${byCodepoint.size};

export const EXCALIFONT_ADVANCE_RUNS: ReadonlyArray<ReadonlyArray<number>> = [
${body}
];
`
  writeFileSync(OUT, content)
  console.log(
    `excalifont-metrics: ${byCodepoint.size} codepoints, ${runs.length} runs, unitsPerEm ${unitsPerEm}`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
