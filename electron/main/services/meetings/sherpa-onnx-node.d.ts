// O pacote sherpa-onnx-node não publica .d.ts (só JSDoc). Declaramos aqui o
// subconjunto que a diarização usa; assinaturas conferidas em
// node_modules/sherpa-onnx-node/{non-streaming-speaker-diarization,speaker-identification}.js.
declare module 'sherpa-onnx-node' {
  export interface SpeakerDiarizationSegment {
    start: number
    end: number
    speaker: number
  }

  export interface OfflineSpeakerDiarizationConfig {
    segmentation: { pyannote: { model: string }; numThreads?: number; debug?: boolean; provider?: string }
    embedding: { model: string; numThreads?: number; debug?: boolean; provider?: string }
    clustering: { numClusters: number; threshold: number }
    minDurationOn: number
    minDurationOff: number
  }

  export class OfflineSpeakerDiarization {
    constructor(config: OfflineSpeakerDiarizationConfig)
    readonly sampleRate: number
    process(samples: Float32Array): SpeakerDiarizationSegment[]
  }

  export class OnlineStream {
    acceptWaveform(obj: { sampleRate: number; samples: Float32Array }): void
    inputFinished(): void
  }

  export interface SpeakerEmbeddingExtractorConfig {
    model: string
    numThreads?: number
    debug?: boolean
    provider?: string
  }

  export class SpeakerEmbeddingExtractor {
    constructor(config: SpeakerEmbeddingExtractorConfig)
    readonly dim: number
    createStream(): OnlineStream
    isReady(stream: OnlineStream): boolean
    /** `enableExternalBuffer` precisa ser false no Electron (sherpa-onnx#2866). */
    compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array
  }
}
