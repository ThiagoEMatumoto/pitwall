/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import {
  analyzeActivity,
  DEFAULT_ACTIVE_FRAC,
  DEFAULT_P95_DBFS,
  isSilent,
  PcmChunker,
  readActivityThresholds,
  rmsDbfs,
  rmsLinear,
  type Chunk,
} from './pcm-chunker'

const RATE = 16000

function sine(seconds: number, amplitude = 0.3, hz = 440): Buffer {
  const samples = Math.round(seconds * RATE)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / RATE) * amplitude * 32767), i * 2)
  }
  return buf
}

function silence(seconds: number): Buffer {
  return Buffer.alloc(Math.round(seconds * RATE) * 2)
}

const dbToLinear = (db: number) => Math.pow(10, db / 20)

// Ruído branco uniforme com RMS calibrado em dBFS (PRNG determinístico).
function noise(seconds: number, rmsDb: number, seed = 1): Buffer {
  const samples = Math.round(seconds * RATE)
  const buf = Buffer.alloc(samples * 2)
  let x = seed
  const amp = dbToLinear(rmsDb) * Math.sqrt(3) // uniforme em [-a, a] tem RMS a/√3
  for (let i = 0; i < samples; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    const u = (x / 0x7fffffff) * 2 - 1
    buf.writeInt16LE(Math.round(u * amp * 32767), i * 2)
  }
  return buf
}

// "Fala" de mic baixo: seno com RMS −48 dBFS em rajadas de 200 ms, 50% pausa.
function quietSpeech(seconds: number, rmsDb = -48): Buffer {
  const burst = sine(0.2, dbToLinear(rmsDb) * Math.SQRT2)
  const gap = silence(0.2)
  const parts: Buffer[] = []
  for (let t = 0; t < seconds; t += 0.4) parts.push(burst, gap)
  return Buffer.concat(parts)
}

// Alimenta em blocos de 100 ms, como a captura faz.
function feed(chunker: PcmChunker, pcm: Buffer): Chunk[] {
  const block = (RATE / 10) * 2
  const out: Chunk[] = []
  for (let off = 0; off < pcm.length; off += block) {
    out.push(...chunker.push(pcm.subarray(off, Math.min(pcm.length, off + block))))
  }
  return out
}

describe('rms', () => {
  it('seno de amplitude 0.3 mede ~0.21 linear (~-13.5 dBFS); silêncio é -100', () => {
    const s = sine(1)
    expect(rmsLinear(s)).toBeCloseTo(0.3 / Math.SQRT2, 2)
    expect(rmsDbfs(s)).toBeCloseTo(-13.5, 0)
    expect(rmsDbfs(silence(1))).toBe(-100)
    expect(rmsLinear(Buffer.alloc(0))).toBe(0)
  })
})

describe('PcmChunker', () => {
  it('corta no primeiro vale de silêncio depois de targetSec, com overlap de 1 s', () => {
    const chunker = new PcmChunker()
    const audio = Buffer.concat([sine(13), silence(2), sine(5)])
    const chunks = feed(chunker, audio)

    expect(chunks).toHaveLength(1)
    const [first] = chunks
    expect(first.index).toBe(0)
    expect(first.startMs).toBe(0)
    // primeira janela silenciosa após 12 s é a de 13.00–13.02 s
    expect(first.endMs).toBe(13020)
    expect(first.silent).toBe(false)
    expect(first.pcm.length).toBe((13020 / 1000) * RATE * 2)

    const [rest] = chunker.flush()
    expect(rest.index).toBe(1)
    expect(rest.startMs).toBe(first.endMs - 1000)
    expect(rest.endMs).toBe(20000)
    expect(rest.silent).toBe(false)
  })

  it('força o corte em maxSec quando não há vale', () => {
    const chunker = new PcmChunker()
    const chunks = feed(chunker, sine(25))
    expect(chunks).toHaveLength(1)
    expect(chunks[0].endMs).toBe(20000)
    expect(chunks[0].pcm.length).toBe(20 * RATE * 2)
  })

  it('marca chunk de silêncio como silent', () => {
    const chunker = new PcmChunker()
    const chunks = feed(chunker, silence(15))
    expect(chunks).toHaveLength(1)
    expect(chunks[0].silent).toBe(true)
    expect(chunks[0].rms).toBe(0)
    expect(chunks[0].endMs).toBe(12020)
  })

  it('flush descarta resto menor que minSec e devolve resto maior', () => {
    const short = new PcmChunker()
    short.push(sine(2))
    expect(short.flush()).toHaveLength(0)

    const long = new PcmChunker()
    long.push(sine(6))
    const [chunk] = long.flush()
    expect(chunk.startMs).toBe(0)
    expect(chunk.endMs).toBe(6000)
  })

  it('mantém timestamps absolutos ao longo de vários cortes', () => {
    const chunker = new PcmChunker()
    const audio = Buffer.concat([sine(12.5), silence(0.5), sine(12.5), silence(0.5), sine(12.5)])
    const chunks = feed(chunker, audio)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].endMs).toBe(12520)
    expect(chunks[1].startMs).toBe(11520)
    // segundo corte: primeira janela silenciosa após 11520+12000 = 23520 ms → vale em 25.5 s
    expect(chunks[1].endMs).toBe(25520)
    expect(chunks.map((c) => c.index)).toEqual([0, 1])
  })
})

describe('gate por atividade (janelas de 20 ms)', () => {
  it('fala sintética a −48 dBFS com 50% de pausas NÃO é silent (RMS médio ficaria abaixo de −45)', () => {
    const chunks = feed(new PcmChunker(), quietSpeech(13))
    expect(chunks).toHaveLength(1)
    const [c] = chunks
    expect(c.rmsDbfs).toBeLessThan(-45)
    expect(c.activeFrac).toBeCloseTo(0.5, 1)
    expect(c.p95Dbfs).toBeCloseTo(-48, 0)
    expect(c.peakDbfs).toBeCloseTo(-45, 0)
    expect(c.silent).toBe(false)
  })

  it('ruído contínuo a −70 dBFS é silent', () => {
    const [c] = feed(new PcmChunker(), noise(13, -70))
    expect(c.activeFrac).toBe(0)
    expect(c.p95Dbfs).toBeLessThan(-60)
    expect(c.silent).toBe(true)
  })

  it('ruído contínuo a −52 dBFS sem picos é silent (sem dinâmica sobre o chão)', () => {
    const [c] = feed(new PcmChunker(), noise(21, -52)) // sem vale: só corta em maxSec
    expect(c.p95Dbfs).toBeCloseTo(-52, 0)
    expect(c.activeFrac).toBeLessThan(DEFAULT_ACTIVE_FRAC)
    expect(c.silent).toBe(true)
  })

  it('fala contínua a −48 sem pausas passa pelo p95', () => {
    const stats = analyzeActivity(sine(5, dbToLinear(-48) * Math.SQRT2))
    expect(stats.p95Dbfs).toBeGreaterThan(DEFAULT_P95_DBFS)
    expect(isSilent(stats)).toBe(false)
  })

  it('thresholds vêm do env quando válidos', () => {
    expect(readActivityThresholds({})).toEqual({ activeFrac: DEFAULT_ACTIVE_FRAC, p95Dbfs: DEFAULT_P95_DBFS })
    expect(readActivityThresholds({ CM_MEETING_ACTIVE_FRAC: '0.2', CM_MEETING_P95_DBFS: '-40' })).toEqual({
      activeFrac: 0.2,
      p95Dbfs: -40,
    })
    expect(readActivityThresholds({ CM_MEETING_ACTIVE_FRAC: '7', CM_MEETING_P95_DBFS: 'x' })).toEqual({
      activeFrac: DEFAULT_ACTIVE_FRAC,
      p95Dbfs: DEFAULT_P95_DBFS,
    })
    const stats = analyzeActivity(quietSpeech(5))
    expect(isSilent(stats, { activeFrac: 0.9, p95Dbfs: -40 })).toBe(true)
  })
})
