/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { normalizePeak } from './gain'
import { peakDbfs } from './pcm-chunker'

function sine(seconds: number, amplitude: number, hz = 440, rate = 16000): Buffer {
  const samples = Math.round(seconds * rate)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amplitude * 32767), i * 2)
  }
  return buf
}

const dbToLinear = (db: number) => Math.pow(10, db / 20)

describe('normalizePeak', () => {
  it('leva um sinal a −40 dBFS de pico pra −10 (limite de +30 dB) sem clipar', () => {
    const quiet = sine(1, dbToLinear(-40))
    const { pcm, gainDb } = normalizePeak(quiet)
    expect(gainDb).toBeCloseTo(30, 1)
    expect(peakDbfs(pcm)).toBeCloseTo(-10, 0)
    expect(pcm.length).toBe(quiet.length)
    expect(pcm).not.toBe(quiet)
  })

  it('leva um sinal a −20 dBFS pro alvo −3', () => {
    const { pcm, gainDb } = normalizePeak(sine(1, dbToLinear(-20)))
    expect(gainDb).toBeCloseTo(17, 0)
    expect(peakDbfs(pcm)).toBeCloseTo(-3, 0)
    let clipped = 0
    for (let i = 0; i < pcm.length; i += 2) {
      const v = pcm.readInt16LE(i)
      if (v >= 32767 || v <= -32768) clipped++
    }
    expect(clipped).toBe(0)
  })

  it('não altera o que já está no alvo ou acima, nem silêncio', () => {
    const loud = sine(1, dbToLinear(-1))
    expect(normalizePeak(loud)).toEqual({ pcm: loud, gainDb: 0 })
    const silence = Buffer.alloc(3200)
    expect(normalizePeak(silence)).toEqual({ pcm: silence, gainDb: 0 })
  })

  it('respeita target e maxGain customizados', () => {
    const { pcm, gainDb } = normalizePeak(sine(0.5, dbToLinear(-30)), { targetDbfs: -6, maxGainDb: 10 })
    expect(gainDb).toBeCloseTo(10, 5)
    expect(peakDbfs(pcm)).toBeCloseTo(-20, 0)
  })
})
