/** @vitest-environment node */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeWav, parseWav, readWavPcm } from './wav'

const fixtures = resolve(__dirname, '../../../../e2e/fixtures/meetings')

describe('encodeWav', () => {
  it('escreve header de 44 bytes com rate/canais e tamanho do PCM', () => {
    const pcm = Buffer.alloc(3200, 7)
    const wav = encodeWav(pcm)
    expect(wav.length).toBe(44 + 3200)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(4)).toBe(36 + 3200)
    expect(wav.toString('ascii', 36, 40)).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(3200)
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(28)).toBe(32000)
  })

  it('faz roundtrip com parseWav', () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6])
    const parsed = parseWav(encodeWav(pcm, 8000, 2))
    expect(parsed.rate).toBe(8000)
    expect(parsed.channels).toBe(2)
    expect(Buffer.compare(parsed.pcm, pcm)).toBe(0)
  })
})

describe('readWavPcm', () => {
  it('lê as fixtures do ffmpeg (com chunk LIST antes do data)', () => {
    const silence = readWavPcm(resolve(fixtures, 'silence-5s.wav'))
    expect(silence.rate).toBe(16000)
    expect(silence.channels).toBe(1)
    expect(silence.pcm.length).toBe(5 * 16000 * 2)
    expect(silence.pcm.every((b) => b === 0)).toBe(true)

    const mic = readWavPcm(resolve(fixtures, 'mic-eu.wav'))
    expect(mic.pcm.length / 32000).toBeCloseTo(17.94, 1)
  })

  it('rejeita buffer que não é WAV', () => {
    expect(() => parseWav(Buffer.from('nope'))).toThrow(/RIFF/)
  })
})
