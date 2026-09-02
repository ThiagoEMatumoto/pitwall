import { linearToDbfs } from './pcm-chunker'

// Normalização de pico do PCM s16le mono antes do STT e da diarização. Um mic
// com ganho de hardware baixo entrega fala a −48 dBFS; o whisper e o extrator
// de embeddings trabalham bem melhor perto de 0 dBFS. É ganho linear puro
// (sem AGC, sem compressão): limitado a `maxGainDb` pra não amplificar só
// ruído, e nunca acima de `targetDbfs` — logo nunca clipa.

export interface NormalizeOptions {
  targetDbfs?: number
  maxGainDb?: number
}

export const DEFAULT_TARGET_DBFS = -3
export const DEFAULT_MAX_GAIN_DB = 30

const INT16_MAX = 32767
const INT16_MIN = -32768

export function normalizePeak(pcm: Buffer, opts: NormalizeOptions = {}): { pcm: Buffer; gainDb: number } {
  const targetDbfs = opts.targetDbfs ?? DEFAULT_TARGET_DBFS
  const maxGainDb = opts.maxGainDb ?? DEFAULT_MAX_GAIN_DB
  const samples = Math.floor(pcm.length / 2)
  let peak = 0
  for (let i = 0; i < samples; i++) {
    const v = Math.abs(pcm.readInt16LE(i * 2))
    if (v > peak) peak = v
  }
  if (peak === 0) return { pcm, gainDb: 0 }
  const peakDbfs = linearToDbfs(peak / 32768)
  const gainDb = Math.min(targetDbfs - peakDbfs, maxGainDb)
  if (gainDb <= 0) return { pcm, gainDb: 0 }

  const gain = Math.pow(10, gainDb / 20)
  const out = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const v = Math.round(pcm.readInt16LE(i * 2) * gain)
    out.writeInt16LE(Math.max(INT16_MIN, Math.min(INT16_MAX, v)), i * 2)
  }
  return { pcm: out, gainDb }
}
