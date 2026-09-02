import { describe, expect, it, vi } from 'vitest'
import { createWorkerHandler, s16ToFloat32, type DiarizerEngine } from './diarizer-worker'
import type { SherpaModule } from './native-loader'

const models = { segmentation: '/seg.onnx', embedding: '/emb.onnx' }
const fakeSherpa = {} as SherpaModule

describe('s16ToFloat32', () => {
  it('converte s16le em float [-1, 1] respeitando byteOffset', () => {
    const buf = Buffer.alloc(8)
    buf.writeInt16LE(0, 0)
    buf.writeInt16LE(32767, 2)
    buf.writeInt16LE(-32768, 4)
    buf.writeInt16LE(16384, 6)
    const view = buf.subarray(2)
    const f = s16ToFloat32(view)
    expect(Array.from(f)).toEqual([32767 / 32768, -1, 0.5])
  })
})

describe('createWorkerHandler', () => {
  it('sem addon: init responde unavailable com o erro do loader, diarize responde erro', () => {
    const handle = createWorkerHandler({ load: () => null, loadError: () => 'sem .node' })
    expect(handle({ type: 'status' })).toEqual({ type: 'status', status: 'loading', error: null, dim: null })
    expect(handle({ type: 'init', models })).toEqual({ type: 'status', status: 'unavailable', error: 'sem .node', dim: null })
    expect(handle({ type: 'diarize', id: 7, pcm: new Uint8Array(4) })).toEqual({ type: 'result', id: 7, error: 'sem .node' })
  })

  it('com engine: init fica ready e diarize devolve os turnos com o id', () => {
    const engine: DiarizerEngine = { dim: 3, diarize: vi.fn(() => [{ startMs: 0, endMs: 500, localSpeaker: 0, embedding: [1, 0, 0] }]) }
    const handle = createWorkerHandler({ load: () => fakeSherpa, loadError: () => null, buildEngine: () => engine })
    expect(handle({ type: 'init', models })).toEqual({ type: 'status', status: 'ready', error: null, dim: 3 })
    const pcm = new Uint8Array(4)
    expect(handle({ type: 'diarize', id: 1, pcm })).toEqual({
      type: 'result',
      id: 1,
      turns: [{ startMs: 0, endMs: 500, localSpeaker: 0, embedding: [1, 0, 0] }],
    })
    expect(engine.diarize).toHaveBeenCalledWith(pcm)
  })

  it('engine que lança no init → unavailable; que lança no diarize → erro por id', () => {
    const broken = createWorkerHandler({
      load: () => fakeSherpa,
      loadError: () => null,
      buildEngine: () => {
        throw new Error('modelo corrompido')
      },
    })
    expect(broken({ type: 'init', models })).toMatchObject({ status: 'unavailable', error: 'modelo corrompido' })

    const flaky = createWorkerHandler({
      load: () => fakeSherpa,
      loadError: () => null,
      buildEngine: () => ({
        dim: 1,
        diarize: () => {
          throw new Error('boom')
        },
      }),
    })
    flaky({ type: 'init', models })
    expect(flaky({ type: 'diarize', id: 2, pcm: new Uint8Array(2) })).toEqual({ type: 'result', id: 2, error: 'boom' })
  })
})
