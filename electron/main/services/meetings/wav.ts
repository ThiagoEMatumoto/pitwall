import { readFileSync } from 'node:fs'

// WAV PCM s16le mínimo: header canônico de 44 bytes na escrita; na leitura
// percorre os chunks RIFF (ffmpeg grava LIST/INFO antes do `data`) até achar
// `fmt ` e `data`.

const HEADER_BYTES = 44

export function encodeWav(pcm: Buffer, rate = 16000, channels = 1): Buffer {
  const bytesPerSample = 2
  const blockAlign = channels * bytesPerSample
  const header = Buffer.alloc(HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // tamanho do fmt (PCM)
  header.writeUInt16LE(1, 20) // formato 1 = PCM inteiro
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bytesPerSample * 8, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export interface WavPcm {
  pcm: Buffer
  rate: number
  channels: number
}

export function parseWav(buf: Buffer): WavPcm {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('não é um arquivo WAV (RIFF/WAVE ausente)')
  }
  let rate = 0
  let channels = 0
  let bits = 0
  let format = 0
  let pcm: Buffer | null = null
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body)
      channels = buf.readUInt16LE(body + 2)
      rate = buf.readUInt32LE(body + 4)
      bits = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      pcm = buf.subarray(body, Math.min(buf.length, body + size))
      break
    }
    // chunks RIFF são alinhados em 2 bytes
    offset = body + size + (size % 2)
  }
  if (!pcm || rate === 0) throw new Error('WAV sem chunk fmt/data')
  if (format !== 1 || bits !== 16) {
    throw new Error(`WAV precisa ser PCM s16 (formato ${format}, ${bits} bits)`)
  }
  return { pcm, rate, channels }
}

export function readWavPcm(path: string): WavPcm {
  return parseWav(readFileSync(path))
}
