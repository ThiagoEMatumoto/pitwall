// Corta o fluxo PCM (s16le mono) em pedaços pro STT. A regra: depois de
// `targetSec`, corta na primeira janela silenciosa (o vale de RMS mais recente,
// já que o fluxo chega incremental); se nenhuma aparecer até `maxSec`, corta
// ali à força. Cada pedaço seguinte começa `overlapSec` antes do corte, para a
// palavra partida ao meio aparecer inteira em pelo menos um dos dois.
//
// PCM fica só em memória: nunca vai pra disco (privacidade).

export interface Chunk {
  pcm: Buffer
  startMs: number
  endMs: number
  index: number
  /** RMS linear 0..1 do pedaço inteiro. */
  rms: number
  /** RMS médio abaixo de `silenceDbfs` — não vale a pena mandar pro STT. */
  silent: boolean
}

export interface PcmChunkerOptions {
  rate?: number
  targetSec?: number
  maxSec?: number
  minSec?: number
  overlapSec?: number
  silenceDbfs?: number
  windowMs?: number
}

const BYTES_PER_SAMPLE = 2

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
export function rmsDbfs(pcm: Buffer): number {
  const rms = rmsLinear(pcm)
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100
}

function dbfsToLinear(db: number): number {
  return Math.pow(10, db / 20)
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
  private readonly silenceDbfs: number

  private pending: Buffer = Buffer.alloc(0)
  /** RMS linear de cada janela completa em `pending`. */
  private windowRms: number[] = []
  /** Índice absoluto (em amostras) do início de `pending`. */
  private startSample = 0
  private nextIndex = 0

  constructor(opts: PcmChunkerOptions = {}) {
    this.rate = opts.rate ?? 16000
    this.windowMs = opts.windowMs ?? 20
    this.bytesPerWindow = Math.round((this.rate * this.windowMs) / 1000) * BYTES_PER_SAMPLE
    const windowsPerSec = 1000 / this.windowMs
    this.targetWindows = Math.round((opts.targetSec ?? 12) * windowsPerSec)
    this.maxWindows = Math.round((opts.maxSec ?? 20) * windowsPerSec)
    this.overlapWindows = Math.round((opts.overlapSec ?? 1) * windowsPerSec)
    this.minBytes = Math.round((opts.minSec ?? 4) * this.rate) * BYTES_PER_SAMPLE
    this.silenceDbfs = opts.silenceDbfs ?? -45
    this.silenceLinear = dbfsToLinear(this.silenceDbfs)
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
    const rms = rmsLinear(pcm)
    const chunk: Chunk = {
      pcm,
      startMs,
      endMs,
      index: this.nextIndex++,
      rms,
      silent: rmsDbfs(pcm) < this.silenceDbfs,
    }
    const keepFromBytes = keepOverlap
      ? Math.max(0, bytes - this.overlapWindows * this.bytesPerWindow)
      : bytes
    this.pending = this.pending.subarray(keepFromBytes)
    this.windowRms = this.windowRms.slice(keepFromBytes / this.bytesPerWindow)
    this.startSample += keepFromBytes / BYTES_PER_SAMPLE
    return chunk
  }

  private samplesToMs(samples: number): number {
    return Math.round((samples * 1000) / this.rate)
  }
}
