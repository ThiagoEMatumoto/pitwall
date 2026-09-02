// Onde moram os modelos da diarização. O pyannote int8 (1,5 MB) vai no
// pacote (extraResources → resourcesPath/models; em dev, build/models). O
// TitaNet (40 MB) não: fica em userData/meeting-models, baixado sob demanda —
// ou reaproveitado do sidecar antigo em ~/.claude-manager se ainda existir.
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface ModelPaths {
  segmentation: string | null
  embedding: string | null
}

export type EmbeddingModelState = 'ready' | 'missing' | 'downloading'

export interface ModelsStatus {
  segmentation: 'ready' | 'missing'
  embedding: EmbeddingModelState
  /** 0..1 durante o download; null fora dele. */
  progress: number | null
}

export interface ModelManagerDeps {
  isPackaged: boolean
  resourcesPath: string
  appRoot: string
  userDataDir: string
  homeDir: string
  fetchImpl: typeof fetch
}

export const SEGMENTATION_MODEL_REL = join('sherpa-onnx-pyannote-segmentation-3-0', 'model.int8.onnx')
export const EMBEDDING_MODEL_FILE = 'nemo_en_titanet_small.onnx'
export const EMBEDDING_MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx'
const LEGACY_SIDECAR_MODELS = join('.claude-manager', 'meeting-sidecar', 'models')

let electronDefaults: (() => Omit<ModelManagerDeps, 'fetchImpl' | 'homeDir'>) | null = null

/** initMeetings registra como achar os paths do Electron; testes injetam deps direto. */
export function setModelManagerDefaults(fn: typeof electronDefaults): void {
  electronDefaults = fn
}

function resolveDeps(partial: Partial<ModelManagerDeps>): ModelManagerDeps {
  const base = electronDefaults?.() ?? {
    isPackaged: false,
    resourcesPath: process.resourcesPath ?? process.cwd(),
    appRoot: process.cwd(),
    userDataDir: join(homedir(), '.config', 'pitwall'),
  }
  return { ...base, homeDir: homedir(), fetchImpl: fetch, ...partial }
}

function segmentationPath(deps: ModelManagerDeps): string {
  const root = deps.isPackaged ? deps.resourcesPath : join(deps.appRoot, 'build')
  return join(root, 'models', SEGMENTATION_MODEL_REL)
}

function embeddingCandidates(deps: ModelManagerDeps): string[] {
  return [
    join(deps.userDataDir, 'meeting-models', EMBEDDING_MODEL_FILE),
    join(deps.homeDir, LEGACY_SIDECAR_MODELS, EMBEDDING_MODEL_FILE),
  ]
}

export function resolveModels(partial: Partial<ModelManagerDeps> = {}): ModelPaths {
  const deps = resolveDeps(partial)
  const seg = segmentationPath(deps)
  return {
    segmentation: existsSync(seg) ? seg : null,
    embedding: embeddingCandidates(deps).find((p) => existsSync(p)) ?? null,
  }
}

interface DownloadState {
  promise: Promise<string>
  progress: number
}
let download: DownloadState | null = null

export function modelsStatus(partial: Partial<ModelManagerDeps> = {}): ModelsStatus {
  const paths = resolveModels(partial)
  return {
    segmentation: paths.segmentation ? 'ready' : 'missing',
    embedding: paths.embedding ? 'ready' : download ? 'downloading' : 'missing',
    progress: download ? download.progress : null,
  }
}

// Stream → .part → rename, pra nunca deixar um .onnx truncado passando por
// pronto. Um segundo pedido durante o download pega a mesma promise.
export function downloadEmbeddingModel(
  onProgress: (p: number) => void,
  partial: Partial<ModelManagerDeps> = {},
): Promise<string> {
  if (download) {
    onProgress(download.progress)
    return download.promise
  }
  const deps = resolveDeps(partial)
  const existing = embeddingCandidates(deps).find((p) => existsSync(p))
  if (existing) return Promise.resolve(existing)

  const state: DownloadState = { progress: 0, promise: Promise.resolve('') }
  state.promise = runDownload(deps, (p) => {
    state.progress = p
    onProgress(p)
  }).finally(() => {
    download = null
  })
  download = state
  return state.promise
}

async function runDownload(deps: ModelManagerDeps, onProgress: (p: number) => void): Promise<string> {
  const dir = join(deps.userDataDir, 'meeting-models')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, EMBEDDING_MODEL_FILE)
  const part = `${target}.part`

  const res = await deps.fetchImpl(EMBEDDING_MODEL_URL)
  if (!res.ok || !res.body) {
    throw new Error(`download do modelo de vozes falhou: HTTP ${res.status}`)
  }
  const total = Number(res.headers.get('content-length')) || 0
  let received = 0
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total > 0) onProgress(Math.min(1, received / total))
  })
  try {
    await pipeline(source, createWriteStream(part))
  } catch (err) {
    rmSync(part, { force: true })
    throw err
  }
  if (total > 0 && received !== total) {
    rmSync(part, { force: true })
    throw new Error(`download do modelo de vozes incompleto: ${received}/${total} bytes`)
  }
  renameSync(part, target)
  onProgress(1)
  return target
}

/** Só para testes. */
export function resetModelManager(): void {
  download = null
  electronDefaults = null
}
