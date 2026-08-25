#!/usr/bin/env node
// Sinteza os SFX do video com ffmpeg puro — nenhum sample baixado, nenhuma
// licenca a rastrear, e o resultado e deterministico (por isso public/audio
// pode continuar fora do git).
//
// A regra de gosto: curto (<1.2s) e discreto. O SFX pontua o corte, nao compete
// com a narracao — todos saem bem abaixo de 0 dBFS.
//
// Uso: node scripts/sfx.mjs [--force]

import {execFile} from 'node:child_process'
import {existsSync, mkdirSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

const VIDEO_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(VIDEO_DIR, 'public', 'audio', 'sfx')

const RATE = 48_000

// Gotcha medido neste ffmpeg (8.0.1): a fonte `sine` NAO sai em fundo de escala
// — ela entrega ~-18 dBFS, entao um `volume=` calculado em cima dela erra por
// 18 dB. `aevalsrc` respeita a amplitude escrita na expressao, entao todas as
// fontes tonais aqui usam aevalsrc e o pico final e previsivel.

const SFX = [
  {
    name: 'whoosh',
    why: 'transicao entre cenas — ruido branco filtrado, entra rapido e sai longo',
    source: `anoisesrc=color=white:amplitude=0.6:duration=0.9:sample_rate=${RATE}`,
    filter: [
      'highpass=f=700',
      'lowpass=f=6500',
      'afade=t=in:st=0:d=0.3:curve=exp',
      'afade=t=out:st=0.3:d=0.6:curve=exp',
      'volume=0.30',
    ],
  },
  {
    name: 'tick',
    why: 'aparicao de texto/chip — clique seco, sem cauda',
    source: `anoisesrc=color=white:amplitude=0.8:duration=0.05:sample_rate=${RATE}`,
    filter: [
      'highpass=f=1800',
      'lowpass=f=5200',
      'afade=t=out:st=0:d=0.05:curve=exp',
      'volume=0.35',
    ],
  },
  {
    name: 'sub-hit',
    // Queda de 70 Hz para ~49 Hz (f(t) = 70 - 30*t): o glide descendente e o
    // que faz o grave ler como impacto em vez de nota.
    why: 'corte seco / impacto do logo — grave com glide descendente e decaimento rapido',
    source: `aevalsrc=0.9*sin(2*PI*(70*t-15*t*t)):duration=0.7:sample_rate=${RATE}`,
    filter: [
      'lowpass=f=170',
      'afade=t=in:st=0:d=0.008',
      'afade=t=out:st=0.04:d=0.66:curve=exp',
      'volume=0.28',
    ],
  },
  {
    name: 'riser',
    // sine nao varre frequencia; aevalsrc com fase quadratica da o chirp
    // 210 Hz -> ~1000 Hz em 1.1s (f(t) = 210 + 720*t).
    why: 'tensao antes do corte do cold-open — chirp linear ascendente',
    source: `aevalsrc=0.5*sin(2*PI*(210*t+360*t*t)):duration=1.1:sample_rate=${RATE}`,
    filter: [
      'highpass=f=150',
      'afade=t=in:st=0:d=0.85:curve=exp',
      'afade=t=out:st=1.0:d=0.1',
      'volume=0.22',
    ],
  },
]

async function render(sfx, force) {
  const out = join(OUT_DIR, `${sfx.name}.wav`)
  if (existsSync(out) && !force) {
    console.log(`  cache  ${sfx.name}.wav`)
    return
  }
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', sfx.source,
    '-filter:a', sfx.filter.join(','),
    '-ac', '1',
    '-ar', String(RATE),
    '-c:a', 'pcm_s16le',
    out,
  ])
  console.log(`  ok     ${sfx.name}.wav  — ${sfx.why}`)
}

async function main() {
  const force = process.argv.includes('--force')
  mkdirSync(OUT_DIR, {recursive: true})
  console.log(`SFX -> ${OUT_DIR}`)
  for (const sfx of SFX) await render(sfx, force)
}

main().catch((err) => {
  console.error(err.stderr?.toString().trim() || err.message)
  process.exit(1)
})
