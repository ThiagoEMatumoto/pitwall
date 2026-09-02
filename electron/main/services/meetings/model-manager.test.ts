import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMBEDDING_MODEL_FILE,
  EMBEDDING_MODEL_URL,
  downloadEmbeddingModel,
  modelsStatus,
  resetModelManager,
  resolveModels,
  setModelManagerDefaults,
  type ModelManagerDeps,
} from './model-manager'

const SEG_REL = join('models', 'sherpa-onnx-pyannote-segmentation-3-0', 'model.int8.onnx')

let root: string
let deps: ModelManagerDeps

function fakeFetch(body: Uint8Array[], opts: { status?: number; contentLength?: number | null } = {}): typeof fetch {
  return vi.fn(async () => {
    const status = opts.status ?? 200
    const total = opts.contentLength === undefined ? body.reduce((n, b) => n + b.length, 0) : opts.contentLength
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const b of body) controller.enqueue(b)
        controller.close()
      },
    })
    return new Response(status === 200 ? stream : null, {
      status,
      headers: total === null ? {} : { 'content-length': String(total) },
    })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pw-models-'))
  deps = {
    isPackaged: false,
    resourcesPath: join(root, 'resources'),
    appRoot: join(root, 'app'),
    userDataDir: join(root, 'userData'),
    homeDir: join(root, 'home'),
    fetchImpl: fakeFetch([]),
  }
})

afterEach(() => {
  resetModelManager()
  rmSync(root, { recursive: true, force: true })
})

function touch(path: string, content = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

describe('resolveModels', () => {
  it('em dev procura o int8 em build/models; empacotado em resourcesPath/models', () => {
    expect(resolveModels(deps).segmentation).toBeNull()
    const dev = join(deps.appRoot, 'build', SEG_REL)
    touch(dev)
    expect(resolveModels(deps).segmentation).toBe(dev)

    const packaged = join(deps.resourcesPath, SEG_REL)
    touch(packaged)
    expect(resolveModels({ ...deps, isPackaged: true }).segmentation).toBe(packaged)
  })

  it('TitaNet: userData primeiro, sidecar legado em ~/.claude-manager como fallback', () => {
    expect(resolveModels(deps).embedding).toBeNull()
    const legacy = join(deps.homeDir, '.claude-manager', 'meeting-sidecar', 'models', EMBEDDING_MODEL_FILE)
    touch(legacy)
    expect(resolveModels(deps).embedding).toBe(legacy)
    const own = join(deps.userDataDir, 'meeting-models', EMBEDDING_MODEL_FILE)
    touch(own)
    expect(resolveModels(deps).embedding).toBe(own)
  })

  it('usa os defaults registrados pelo initMeetings quando não recebe deps', () => {
    setModelManagerDefaults(() => ({
      isPackaged: false,
      resourcesPath: deps.resourcesPath,
      appRoot: deps.appRoot,
      userDataDir: deps.userDataDir,
    }))
    const dev = join(deps.appRoot, 'build', SEG_REL)
    touch(dev)
    expect(resolveModels().segmentation).toBe(dev)
  })
})

describe('modelsStatus', () => {
  it('reflete missing/ready', () => {
    expect(modelsStatus(deps)).toEqual({ segmentation: 'missing', embedding: 'missing', progress: null })
    touch(join(deps.appRoot, 'build', SEG_REL))
    touch(join(deps.userDataDir, 'meeting-models', EMBEDDING_MODEL_FILE))
    expect(modelsStatus(deps)).toEqual({ segmentation: 'ready', embedding: 'ready', progress: null })
  })
})

describe('downloadEmbeddingModel', () => {
  it('baixa em streaming para .part, renomeia no fim e reporta progresso', async () => {
    const chunks = [new Uint8Array(4).fill(1), new Uint8Array(6).fill(2)]
    const fetchImpl = fakeFetch(chunks)
    const progress: number[] = []
    const target = await downloadEmbeddingModel((p) => progress.push(p), { ...deps, fetchImpl })

    expect(target).toBe(join(deps.userDataDir, 'meeting-models', EMBEDDING_MODEL_FILE))
    expect(readFileSync(target)).toHaveLength(10)
    expect(existsSync(`${target}.part`)).toBe(false)
    expect(progress.at(-1)).toBe(1)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(fetchImpl).toHaveBeenCalledWith(EMBEDDING_MODEL_URL)
  })

  it('durante o download modelsStatus diz downloading, e um 2º pedido reusa a promise', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const fetchImpl = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new Uint8Array(5))
          await gate
          controller.enqueue(new Uint8Array(5))
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-length': '10' } })
    }) as unknown as typeof fetch

    const first = downloadEmbeddingModel(() => {}, { ...deps, fetchImpl })
    await new Promise((r) => setTimeout(r, 10))
    expect(modelsStatus(deps).embedding).toBe('downloading')
    expect(modelsStatus(deps).progress).toBeCloseTo(0.5)
    const second = downloadEmbeddingModel(() => {}, { ...deps, fetchImpl })
    expect(second).toBe(first)
    release()
    await first
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(modelsStatus(deps).embedding).toBe('ready')
  })

  it('HTTP != 200 falha sem deixar .part', async () => {
    await expect(
      downloadEmbeddingModel(() => {}, { ...deps, fetchImpl: fakeFetch([], { status: 404 }) }),
    ).rejects.toThrow('HTTP 404')
    expect(existsSync(join(deps.userDataDir, 'meeting-models', `${EMBEDDING_MODEL_FILE}.part`))).toBe(false)
  })

  it('download truncado (bytes < content-length) falha e apaga o .part', async () => {
    const fetchImpl = fakeFetch([new Uint8Array(3)], { contentLength: 10 })
    await expect(downloadEmbeddingModel(() => {}, { ...deps, fetchImpl })).rejects.toThrow('incompleto')
    const dir = join(deps.userDataDir, 'meeting-models')
    expect(existsSync(join(dir, `${EMBEDDING_MODEL_FILE}.part`))).toBe(false)
    expect(existsSync(join(dir, EMBEDDING_MODEL_FILE))).toBe(false)
  })

  it('modelo já presente: não baixa', async () => {
    const own = join(deps.userDataDir, 'meeting-models', EMBEDDING_MODEL_FILE)
    touch(own)
    const fetchImpl = fakeFetch([])
    expect(await downloadEmbeddingModel(() => {}, { ...deps, fetchImpl })).toBe(own)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
