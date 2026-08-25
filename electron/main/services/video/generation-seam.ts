import type {
  GenerateVideoAssetsResult,
  GenerateVideoAudioInput,
  GenerateVideoImageInput,
  StartVideoRenderInput,
  VideoRenderMeta,
} from '../../../../shared/types/ipc'

// Seam leaf (sem electron) pros dois processos CAROS da área: gerar asset
// (ElevenLabs/Gemini — custa dinheiro) e renderizar (Remotion — custa minutos de
// CPU). Mesma motivação e mesmo padrão de handoff/spawn-child.ts e
// job-run-now.ts: tools MCP e IPC chamam por aqui e a impl real se registra no
// boot, senão os handlers arrastariam o pipeline inteiro (fetch, ffmpeg, spawn)
// pros testes.
//
// `planAudio`/`planImage` existem por causa do TETO DE CUSTO: a tool de geração
// é dry-run por default e precisa responder "quanto isto vai custar" SEM gastar.
// Quem sabe o preço e a idempotência por hash é o serviço — a tool só compara o
// plano com o teto que o chamador declarou. Plano NUNCA chama API paga.

export interface VideoGenerationPlanItem {
  sceneId: string | null
  locale: string | null
  // true = já existe asset com o mesmo hash; entra no lote como reuso, custo 0.
  reused: boolean
  costCents: number
  // O que seria gerado, em uma linha (texto da narração, prompt da imagem).
  label: string
}

export interface VideoGenerationPlan {
  items: VideoGenerationPlanItem[]
  toGenerate: number
  reused: number
  // Custo só do que seria EFETIVAMENTE gerado (reuso não entra).
  estimatedCostCents: number
  provider: string
  model: string
}

export interface VideoGenerator {
  planAudio(input: GenerateVideoAudioInput): VideoGenerationPlan
  planImage(input: GenerateVideoImageInput): VideoGenerationPlan
  generateAudio(input: GenerateVideoAudioInput): Promise<GenerateVideoAssetsResult>
  generateImage(input: GenerateVideoImageInput): Promise<GenerateVideoAssetsResult>
  startRender(input: StartVideoRenderInput): VideoRenderMeta
}

let impl: VideoGenerator | null = null

export function setVideoGenerator(generator: VideoGenerator): void {
  impl = generator
}

export function clearVideoGenerator(): void {
  impl = null
}

// Lança se o serviço ainda não registrou a impl (ex.: ambiente de teste sem
// electron, ou boot que não inicializou o pipeline) — falha explícita e legível,
// nunca silenciosa e nunca um stack trace de módulo faltando.
export function videoGenerator(): VideoGenerator {
  if (!impl) {
    throw new Error(
      'video generation pipeline is not available in this process: the TTS/image/render service has not been registered',
    )
  }
  return impl
}
