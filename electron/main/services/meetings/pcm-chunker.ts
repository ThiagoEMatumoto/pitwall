// Corta o fluxo PCM (s16le mono) em pedaços pro STT. A regra: depois de
// `targetSec`, corta na primeira janela inativa (o vale de RMS mais recente,
// já que o fluxo chega incremental); se nenhuma aparecer até `maxSec`, corta
// ali à força. Cada pedaço seguinte começa `overlapSec` antes do corte, para a
// palavra partida ao meio aparecer inteira em pelo menos um dos dois.
//
// O gate `silent` NÃO usa o RMS médio do pedaço: um mic com ganho baixo
// (fala a −48 dBFS, metade do tempo em pausa) tem média abaixo de qualquer
// limiar razoável e era descartado inteiro. Em vez disso mede por janela de
// 20 ms: fração de janelas ativas e p95 — fala tem picos e dinâmica; ruído
// contínuo não tem nem um nem outro.
//
// PCM fica só em memória: nunca vai pra disco (privacidade).

export interface ActivityStats {
  /** RMS do pedaço inteiro, em dBFS. */
  rmsDbfs: number
  /** Pico absoluto de amostra, em dBFS. */
  peakDbfs: number
  /** p95 do RMS das janelas de 20 ms, em dBFS. */
  p95Dbfs: number
  /** p20 do RMS das janelas — o "chão" de ruído do pedaço. */
  noiseFloorDbfs: number
  /** Fração de janelas ativas (acima de −55 dBFS e ≥ 6 dB sobre o chão). */
  activeFrac: number
}

export interface Chunk extends ActivityStats {
  pcm: Buffer
  /** Preenchido pelo recorder (gain.normalizePeak) — o que vai pro STT e pra diarização. */
  pcmNormalized?: Buffer
  gainDb?: number
  startMs: number
  endMs: number
  index: number
  /** RMS linear 0..1 do pedaço inteiro. */
  rms: number
  /** Sem atividade de voz (ver `isSilent`) — não vale a pena mandar pro STT. */
  silent: boolean
}

export interface PcmChunkerOptions {
  rate?: number
  targetSec?: number
  maxSec?: number
  minSec?: number
  overlapSec?: number
  /** Janela abaixo disto é candidata a corte (vale). */
  silenceDbfs?: number
  windowMs?: number
}

const BYTES_PER_SAMPLE = 2
const SILENCE_DBFS = -100

/** Janela com RMS acima disto pode contar como ativa. */
export const ACTIVE_WINDOW_DBFS = -55
/** …desde que também fique este tanto acima do chão de ruído do pedaço. */
export const ACTIVE_MARGIN_DB = 6
export const DEFAULT_ACTIVE_FRAC = 0.08
export const DEFAULT_P95_DBFS = -50
export const WINDOW_MS = 20

export interface ActivityThresholds {
  activeFrac: number
  p95Dbfs: number
}

export function readActivityThresholds(env: NodeJS.ProcessEnv = process.env): ActivityThresholds {
  const frac = Number(env.CM_MEETING_ACTIVE_FRAC)
  const p95 = Number(env.CM_MEETING_P95_DBFS)
  return {
    activeFrac: Number.isFinite(frac) && frac >= 0 && frac <= 1 ? frac : DEFAULT_ACTIVE_FRAC,
    p95Dbfs: Number.isFinite(p95) && p95 <= 0 ? p95 : DEFAULT_P95_DBFS,
  }
}

/** Lidos uma vez por processo — tuning sem rebuild. */
export const ACTIVITY_THRESHOLDS: ActivityThresholds = readActivityThresholds()

export function rmsLinear(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / BYTES_PER_SAMPLE)
  if (samples === 0) return 0
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const v = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / 32768
    sum += v * v
  }
  return Math.sqrt(sum / samples)
}

// -100 dBFS no silêncio absoluto em vez de -Infinity: continua abaixo de
// qualquer limiar e sobrevive a JSON.
export function linearToDbfs(linear: number): number {
  return linear > 0 ? Math.max(SILENCE_DBFS, 20 * Math.log10(linear)) : SILENCE_DBFS
}

export function rmsDbfs(pcm: Buffer): number {
  return linearToDbfs(rmsLinear(pcm))
}

function dbfsToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

export function peakDbfs(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / BYTES_PER_SAMPLE)
  let peak = 0
  for (let i = 0; i < samples; i++) {
    const v = Math.abs(pcm.readInt16LE(i * BYTES_PER_SAMPLE))
    if (v > peak) peak = v
  }
  return linearToDbfs(peak / 32768)
}

/** RMS em dBFS de cada janela completa de `windowMs`. */
export function windowDbfs(pcm: Buffer, rate = 16000, windowMs = WINDOW_MS): number[] {
  const bytesPerWindow = Math.round((rate * windowMs) / 1000) * BYTES_PER_SAMPLE
  const total = Math.floor(pcm.length / bytesPerWindow)
  const out: number[] = []
  for (let w = 0; w < total; w++) {
    out.push(rmsDbfs(pcm.subarray(w * bytesPerWindow, (w + 1) * bytesPerWindow)))
  }
  return out
}

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return SILENCE_DBFS
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * (sortedAsc.length - 1)))
  return sortedAsc[idx]
}

export function analyzeActivity(pcm: Buffer, rate = 16000): ActivityStats {
  const windows = windowDbfs(pcm, rate)
  const sorted = [...windows].sort((a, b) => a - b)
  const noiseFloor = percentile(sorted, 0.2)
  const activeAbove = Math.max(ACTIVE_WINDOW_DBFS, noiseFloor + ACTIVE_MARGIN_DB)
  const active = windows.filter((db) => db > activeAbove).length
  return {
    rmsDbfs: rmsDbfs(pcm),
    peakDbfs: peakDbfs(pcm),
    p95Dbfs: percentile(sorted, 0.95),
    noiseFloorDbfs: noiseFloor,
    activeFrac: windows.length ? active / windows.length : 0,
  }
}

export function isSilent(stats: ActivityStats, thresholds: ActivityThresholds = ACTIVITY_THRESHOLDS): boolean {
  return !(stats.activeFrac >= thresholds.activeFrac || stats.p95Dbfs > thresholds.p95Dbfs)
}

export class PcmChunker {
  private readonly rate: number
  private readonly bytesPerWindow: number
  private readonly windowMs: number
  private readonly targetWindows: number
  private readonly maxWindows: number
  private readonly overlapWindows: number
  private readonly minBytes: number
  private readonly silenceLinear: number

  private pending: Buffer = Buffer.alloc(0)
  /** RMS linear de cada janela completa em `pending`. */
  private windowRms: number[] = []
  /** Índice absoluto (em amostras) do início de `pending`. */
  private startSample = 0
  private nextIndex = 0

  constructor(opts: PcmChunkerOptions = {}) {
    this.rate = opts.rate ?? 16000
    this.windowMs = opts.windowMs ?? WINDOW_MS
    this.bytesPerWindow = Math.round((this.rate * this.windowMs) / 1000) * BYTES_PER_SAMPLE
    const windowsPerSec = 1000 / this.windowMs
    this.targetWindows = Math.round((opts.targetSec ?? 12) * windowsPerSec)
    this.maxWindows = Math.round((opts.maxSec ?? 20) * windowsPerSec)
    this.overlapWindows = Math.round((opts.overlapSec ?? 1) * windowsPerSec)
    this.minBytes = Math.round((opts.minSec ?? 4) * this.rate) * BYTES_PER_SAMPLE
    // Mesmo limiar de "janela ativa": num mic baixo, −45 não achava vale nenhum
    // e o corte caía sempre no meio da palavra em targetSec.
    this.silenceLinear = dbfsToLinear(opts.silenceDbfs ?? ACTIVE_WINDOW_DBFS)
  }

  push(pcm: Buffer): Chunk[] {
    if (pcm.length === 0) return []
    this.pending = Buffer.concat([this.pending, pcm])
    this.computeWindows()
    const out: Chunk[] = []
    for (;;) {
      const cut = this.findCut()
      if (cut === null) break
      out.push(this.emit(cut * this.bytesPerWindow, true))
    }
    return out
  }

  /** Fim da gravação: devolve o resto se tiver pelo menos `minSec`. */
  flush(): Chunk[] {
    const out: Chunk[] = []
    if (this.pending.length >= this.minBytes) {
      out.push(this.emit(this.pending.length, false))
    }
    this.pending = Buffer.alloc(0)
    this.windowRms = []
    return out
  }

  private computeWindows(): void {
    const total = Math.floor(this.pending.length / this.bytesPerWindow)
    for (let w = this.windowRms.length; w < total; w++) {
      const start = w * this.bytesPerWindow
      this.windowRms.push(rmsLinear(this.pending.subarray(start, start + this.bytesPerWindow)))
    }
  }

  // Número de janelas a incluir no próximo pedaço, ou null se ainda não há corte.
  private findCut(): number | null {
    const windows = this.windowRms.length
    if (windows < this.targetWindows) return null
    const limit = Math.min(windows, this.maxWindows)
    for (let w = this.targetWindows; w < limit; w++) {
      if (this.windowRms[w] < this.silenceLinear) return w + 1
    }
    return windows >= this.maxWindows ? this.maxWindows : null
  }

  private emit(bytes: number, keepOverlap: boolean): Chunk {
    const pcm = Buffer.from(this.pending.subarray(0, bytes))
    const startMs = this.samplesToMs(this.startSample)
    const endMs = this.samplesToMs(this.startSample + bytes / BYTES_PER_SAMPLE)
    const stats = analyzeActivity(pcm, this.rate)
    const chunk: Chunk = {
      pcm,
      startMs,
      endMs,
      index: this.nextIndex++,
      rms: rmsLinear(pcm),
      ...stats,
      silent: isSilent(stats),
    }
    const keepFromBytes = keepOverlap ? Math.max(0, bytes - this.overlapWindows * this.bytesPerWindow) : bytes
    this.pending = this.pending.subarray(keepFromBytes)
    this.windowRms = this.windowRms.slice(keepFromBytes / this.bytesPerWindow)
    this.startSample += keepFromBytes / BYTES_PER_SAMPLE
    return chunk
  }

  private samplesToMs(samples: number): number {
    return Math.round((samples * 1000) / this.rate)
  }
}
