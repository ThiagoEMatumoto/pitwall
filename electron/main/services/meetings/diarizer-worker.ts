// Processo filho (utilityProcess.fork) que segura o sherpa-onnx: diarização
// pyannote + embedding TitaNet por turno. Fica fora do main por dois motivos —
// o process() bloqueia a thread por ~0,4 s a cada chunk de 12 s, e um crash
// do addon não pode derrubar o app (o cliente respawna).
//
// Protocolo (parentPort): init → status; status → status; diarize{id,pcm} →
// {id,turns} | {id,error}. O PCM chega s16le 16 kHz mono; os turnos saem
// relativos ao chunk.
import { loadSherpa, sherpaLoadError, type SherpaModule } from './native-loader'

export interface WorkerTurn {
  startMs: number
  endMs: number
  localSpeaker: number
  embedding: number[]
}

export interface WorkerModels {
  segmentation: string
  embedding: string
}

export type WorkerRequest =
  | { type: 'init'; models: WorkerModels }
  | { type: 'status' }
  | { type: 'diarize'; id: number; pcm: Uint8Array }

export type WorkerStatus = 'loading' | 'ready' | 'unavailable'

export type WorkerResponse =
  | { type: 'status'; status: WorkerStatus; error: string | null; dim: number | null }
  | { type: 'result'; id: number; turns: WorkerTurn[] }
  | { type: 'result'; id: number; error: string }

export const SAMPLE_RATE = 16000
/** Turnos mais curtos não rendem embedding útil. */
export const MIN_TURN_SEC = 0.3

export function s16ToFloat32(pcm: Uint8Array): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const n = pcm.byteLength >> 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}

export interface DiarizerEngine {
  dim: number
  diarize(pcm: Uint8Array): WorkerTurn[]
}

export function createEngine(sherpa: SherpaModule, models: WorkerModels): DiarizerEngine {
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: models.segmentation } },
    embedding: { model: models.embedding, numThreads: 1 },
    clustering: { numClusters: -1, threshold: 0.5 },
    minDurationOn: 0.2,
    minDurationOff: 0.5,
  })
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: models.embedding, numThreads: 1 })
  if (sd.sampleRate !== SAMPLE_RATE) {
    throw new Error(`modelo de segmentação espera ${sd.sampleRate} Hz, chunks são ${SAMPLE_RATE} Hz`)
  }

  return {
    dim: extractor.dim,
    diarize(pcm) {
      const samples = s16ToFloat32(pcm)
      const turns: WorkerTurn[] = []
      for (const seg of sd.process(samples)) {
        if (seg.end - seg.start < MIN_TURN_SEC) continue
        const slice = samples.subarray(Math.floor(seg.start * SAMPLE_RATE), Math.floor(seg.end * SAMPLE_RATE))
        const stream = extractor.createStream()
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: slice })
        stream.inputFinished()
        // false = sem external buffer: obrigatório no Electron (sherpa-onnx#2866).
        const embedding = extractor.compute(stream, false)
        turns.push({
          startMs: Math.round(seg.start * 1000),
          endMs: Math.round(seg.end * 1000),
          localSpeaker: seg.speaker,
          embedding: Array.from(embedding),
        })
      }
      return turns
    },
  }
}

export interface WorkerHandlerDeps {
  load: () => SherpaModule | null
  loadError: () => string | null
  buildEngine?: (sherpa: SherpaModule, models: WorkerModels) => DiarizerEngine
}

export function createWorkerHandler(deps: WorkerHandlerDeps): (msg: WorkerRequest) => WorkerResponse {
  const build = deps.buildEngine ?? createEngine
  let engine: DiarizerEngine | null = null
  let status: WorkerStatus = 'loading'
  let error: string | null = null

  const statusReply = (): WorkerResponse => ({
    type: 'status',
    status,
    error,
    dim: engine?.dim ?? null,
  })

  return (msg) => {
    switch (msg.type) {
      case 'init': {
        const sherpa = deps.load()
        if (!sherpa) {
          status = 'unavailable'
          error = deps.loadError() ?? 'addon sherpa-onnx indisponível'
          return statusReply()
        }
        try {
          engine = build(sherpa, msg.models)
          status = 'ready'
          error = null
        } catch (err) {
          status = 'unavailable'
          error = err instanceof Error ? err.message : String(err)
        }
        return statusReply()
      }
      case 'status':
        return statusReply()
      case 'diarize': {
        if (!engine) return { type: 'result', id: msg.id, error: error ?? 'worker não inicializado' }
        try {
          return { type: 'result', id: msg.id, turns: engine.diarize(msg.pcm) }
        } catch (err) {
          return { type: 'result', id: msg.id, error: err instanceof Error ? err.message : String(err) }
        }
      }
    }
  }
}

// Bootstrap só quando de fato rodando como utilityProcess (parentPort existe).
// Tipo local em vez de Electron.ParentPort pra este arquivo não depender de
// `electron` — ele roda num processo sem esse módulo.
interface ParentPortLike {
  on(event: 'message', cb: (event: { data: WorkerRequest }) => void): void
  postMessage(msg: WorkerResponse): void
  start?(): void
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort
if (parentPort) {
  const handle = createWorkerHandler({ load: loadSherpa, loadError: sherpaLoadError })
  parentPort.on('message', (event) => {
    parentPort.postMessage(handle(event.data))
  })
  parentPort.start?.()
}
