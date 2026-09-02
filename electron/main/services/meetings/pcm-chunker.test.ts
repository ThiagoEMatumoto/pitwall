/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { PcmChunker, rmsDbfs, rmsLinear, type Chunk } from './pcm-chunker'

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
