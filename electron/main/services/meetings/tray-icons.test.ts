import { inflateSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createFromBuffer = vi.fn()
vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: (...args: unknown[]) => createFromBuffer(...args) },
}))

import { PNG_SIGNATURE, crc32, drawIcon, encodePng, iconPng, trayIcons } from './tray-icons'

interface Chunk {
  type: string
  data: Buffer
  crcOk: boolean
}

function parseChunks(png: Buffer): Chunk[] {
  const chunks: Chunk[] = []
  let offset = 8
  while (offset < png.length) {
    const len = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    const data = png.subarray(offset + 8, offset + 8 + len)
    const crc = png.readUInt32BE(offset + 8 + len)
    const crcOk = crc === crc32(png.subarray(offset + 4, offset + 8 + len))
    chunks.push({ type, data, crcOk })
    offset += 12 + len
  }
  return chunks
}

function pixel(rgba: Buffer, size: number, x: number, y: number): number[] {
  const i = (y * size + x) * 4
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
}

describe('crc32', () => {
  it('bate com o vetor de teste clássico', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })
})

describe('encodePng', () => {
  it('produz PNG com assinatura, IHDR correto, IDAT decodificável e CRCs válidos', () => {
    const w = 3
    const h = 2
    const rgba = Buffer.alloc(w * h * 4, 0x7f)
    const png = encodePng(w, h, rgba)

    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    const chunks = parseChunks(png)
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(chunks.every((c) => c.crcOk)).toBe(true)

    const ihdr = chunks[0].data
    expect(ihdr.readUInt32BE(0)).toBe(w)
    expect(ihdr.readUInt32BE(4)).toBe(h)
    expect(ihdr[8]).toBe(8) // bit depth
    expect(ihdr[9]).toBe(6) // RGBA
    expect(ihdr[12]).toBe(0) // sem entrelaçamento

    const raw = inflateSync(chunks[1].data)
    expect(raw.length).toBe((w * 4 + 1) * h)
    expect(raw[0]).toBe(0) // filtro da linha 0
    expect(raw.subarray(1, 1 + w * 4).equals(rgba.subarray(0, w * 4))).toBe(true)
    expect(chunks[2].data.length).toBe(0)
  })

  it('rejeita buffer com tamanho errado', () => {
    expect(() => encodePng(2, 2, Buffer.alloc(3))).toThrow(/esperava 16 bytes/)
  })
})

describe('drawIcon', () => {
  const size = 22
  const c = size / 2

  it('recording: disco vermelho opaco no centro, transparente no canto', () => {
    const rgba = drawIcon('recording', size)
    expect(pixel(rgba, size, c, c)).toEqual([0xe5, 0x48, 0x4d, 255])
    expect(pixel(rgba, size, 0, 0)[3]).toBe(0)
  })

  it('recordingDim: mesmo vermelho a 45% de alpha', () => {
    const rgba = drawIcon('recordingDim', size)
    expect(pixel(rgba, size, c, c)).toEqual([0xe5, 0x48, 0x4d, Math.round(0.45 * 255)])
  })

  it('detected: disco âmbar opaco no centro, mesmo formato do recording', () => {
    const rgba = drawIcon('detected', size)
    expect(pixel(rgba, size, c, c)).toEqual([0xf5, 0xa5, 0x24, 255])
    expect(pixel(rgba, size, 0, 0)[3]).toBe(0)
    const recording = drawIcon('recording', size)
    for (let i = 3; i < rgba.length; i += 4) expect(rgba[i]).toBe(recording[i])
  })

  it('idle: anel cinza-claro — centro vazado, borda do anel preenchida', () => {
    const rgba = drawIcon('idle', size)
    expect(pixel(rgba, size, c, c)[3]).toBe(0)
    const ring = pixel(rgba, size, c + 6, c)
    expect(ring.slice(0, 3)).toEqual([0xc8, 0xc8, 0xc8])
    expect(ring[3]).toBeGreaterThan(200)
    expect(pixel(rgba, size, 0, 0)[3]).toBe(0)
  })

  it('iconPng embrulha o desenho num PNG válido nas duas escalas', () => {
    for (const kind of ['recording', 'detected'] as const) {
      for (const size of [22, 44]) {
        const png = iconPng(kind, size)
        const chunks = parseChunks(png)
        expect(chunks[0].data.readUInt32BE(0)).toBe(size)
        expect(chunks.every((ch) => ch.crcOk)).toBe(true)
      }
    }
  })
})

describe('trayIcons', () => {
  beforeEach(() => createFromBuffer.mockReset())

  it('cria os quatro ícones a partir de PNG 22px e anexa a representação @2x', () => {
    const reps: unknown[] = []
    createFromBuffer.mockImplementation(() => ({
      addRepresentation: (rep: unknown) => reps.push(rep),
    }))
    const icons = trayIcons()
    expect(Object.keys(icons)).toEqual(['idle', 'recording', 'recordingDim', 'detected'])
    expect(createFromBuffer).toHaveBeenCalledTimes(4)
    for (const call of createFromBuffer.mock.calls) {
      const buf = call[0] as Buffer
      expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
      expect(call[1]).toEqual({ scaleFactor: 1 })
    }
    expect(reps).toHaveLength(4)
    expect(reps[0]).toMatchObject({ scaleFactor: 2, width: 44, height: 44 })
  })
})
