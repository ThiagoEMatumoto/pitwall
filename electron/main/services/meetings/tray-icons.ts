// Ícones do tray gerados em runtime: PNG RGBA desenhado à mão (zlib + CRC32),
// sem dependência nova. 22 px + representação @2x (44 px) pra HiDPI.
import { deflateSync } from 'node:zlib'
import { nativeImage, type NativeImage } from 'electron'

export type TrayIconKind = 'idle' | 'recording' | 'recordingDim'

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** PNG 8-bit RGBA (color type 6), sem entrelaçamento, filtro 0 por linha. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: esperava ${width * height * 4} bytes, recebeu ${rgba.length}`)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const IDLE_RGB: [number, number, number] = [0xc8, 0xc8, 0xc8]
const RECORDING_RGB: [number, number, number] = [0xe5, 0x48, 0x4d]
const DIM_ALPHA = 0.45
const SUPERSAMPLE = 4

/**
 * Desenha o ícone como RGBA (não pré-multiplicado). idle = anel cinza-claro;
 * recording = disco vermelho; recordingDim = mesmo disco a 45% (fase do pisca).
 * Antialias por supersampling 4×4.
 */
export function drawIcon(kind: TrayIconKind, size: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4)
  const center = size / 2
  const outer = size * 0.36
  const inner = kind === 'idle' ? outer - size * 0.11 : 0
  const [r, g, b] = kind === 'idle' ? IDLE_RGB : RECORDING_RGB
  const alphaScale = kind === 'recordingDim' ? DIM_ALPHA : 1
  const step = 1 / SUPERSAMPLE

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const dx = x + (sx + 0.5) * step - center
          const dy = y + (sy + 0.5) * step - center
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d <= outer && d >= inner) hits++
        }
      }
      const coverage = hits / (SUPERSAMPLE * SUPERSAMPLE)
      const i = (y * size + x) * 4
      rgba[i] = r
      rgba[i + 1] = g
      rgba[i + 2] = b
      rgba[i + 3] = Math.round(coverage * alphaScale * 255)
    }
  }
  return rgba
}

export function iconPng(kind: TrayIconKind, size: number): Buffer {
  return encodePng(size, size, drawIcon(kind, size))
}

function buildImage(kind: TrayIconKind): NativeImage {
  const img = nativeImage.createFromBuffer(iconPng(kind, 22), { scaleFactor: 1 })
  img.addRepresentation({ scaleFactor: 2, width: 44, height: 44, buffer: iconPng(kind, 44) })
  return img
}

export function trayIcons(): Record<TrayIconKind, NativeImage> {
  return {
    idle: buildImage('idle'),
    recording: buildImage('recording'),
    recordingDim: buildImage('recordingDim'),
  }
}
