// Cliente da diarização usado pelo gravador: recebe o PCM de cada chunk da
// trilha `them`, manda pro diarizer-worker, agrupa os embeddings por reunião
// (speaker-clustering) e persiste os speakers. Regras de sobrevivência:
// fila curta (chunk atrasado perde a diarização, nunca o STT), timeout por
// chunk, um respawn do worker, e 'unavailable' sem addon/modelos — a
// gravação nunca depende disto.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { utilityProcess } from 'electron'
import type { WorkerRequest, WorkerResponse, WorkerTurn } from './diarizer-worker'
import { resolveModels, type ModelPaths } from './model-manager'
import { sherpaAvailable, sherpaLoadError } from './native-loader'
import { createMeetingClusterer, type KnownVoice, type MeetingClusterer } from './speaker-clustering'

export interface DiarizedTurn {
  /** Relativos ao início do chunk, como os segmentos do STT. */
  startMs: number
  endMs: number
  speakerId: string
  speakerLabel: string
}

export interface DiarizeChunkInput {
  meetingId: string
  chunkIndex: number
  /** s16le 16 kHz mono. */
  pcm: Buffer
  /** Posição absoluta do chunk na reunião (só informativo aqui). */
  startMs: number
}

export type DiarizerStatus = 'on' | 'off' | 'unavailable' | 'loading'

export interface MeetingDiarizer {
  process(input: DiarizeChunkInput): Promise<DiarizedTurn[]>
  status(): DiarizerStatus
  /** Esquece o clustering da reunião (fim da gravação). */
  reset(meetingId: string): void
  /** Sobe o worker antes do primeiro chunk pra o status sair de 'loading' cedo. */
  warmup(): Promise<void>
  dispose(): void
}

// Espelho das funções que o meeting-store expõe pra speakers/vozes; injetado
// pra este módulo não conhecer o banco.
export interface DiarizerSpeakerRecord {
  id: string
  meetingId: string
  label: string
  voiceId: string | null
  centroid: Float32Array
  turnCount: number
}

export interface DiarizerStore {
  upsertSpeaker(input: DiarizerSpeakerRecord): void
  updateSpeaker(input: { id: string; centroid: Float32Array; turnCount: number }): void
  listVoices(): Array<{ id: string; name: string; embedding: Float32Array }>
}

export interface DiarizerWorkerHandle {
  post(msg: WorkerRequest): void
  onMessage(cb: (msg: WorkerResponse) => void): void
  onExit(cb: (code: number) => void): void
  kill(): void
}

export interface DiarizeFixture {
  speakers: Array<{ label: string }>
  pattern: string
}

export interface DiarizerDeps {
  store?: DiarizerStore
  spawnWorker?: () => DiarizerWorkerHandle
  addonAvailable?: () => boolean
  addonError?: () => string | null
  models?: () => ModelPaths
  enabled?: boolean
  timeoutMs?: number
  initTimeoutMs?: number
  maxPending?: number
  maxRestarts?: number
  threshold?: number
  fixture?: DiarizeFixture | null
  env?: NodeJS.ProcessEnv
  log?: (msg: string) => void
}

export const DIARIZE_FIXTURE_ENV = 'CM_MEETING_DIARIZE_FIXTURE'
export const SPEAKER_THRESHOLD_ENV = 'CM_MEETING_SPEAKER_THRESHOLD'
const SAMPLE_RATE = 16000
const FIXTURE_DIM = 192

export function loadDiarizeFixture(env: NodeJS.ProcessEnv = process.env): DiarizeFixture | null {
  const path = env[DIARIZE_FIXTURE_ENV]
  if (!path) return null
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<DiarizeFixture>
  if (!Array.isArray(raw.speakers) || raw.speakers.length === 0 || typeof raw.pattern !== 'string' || !raw.pattern) {
    throw new Error(`${DIARIZE_FIXTURE_ENV}: precisa de "speakers" (não vazio) e "pattern" (string)`)
  }
  return { speakers: raw.speakers.map((s) => ({ label: String(s.label) })), pattern: raw.pattern }
}

// Um turno cobrindo o chunk inteiro, com embedding one-hot por speaker —
// ortogonais entre si, então o clustering separa sem ambiguidade.
export function fixtureTurns(fixture: DiarizeFixture, chunkIndex: number, durationMs: number): WorkerTurn[] {
  const letter = fixture.pattern[chunkIndex % fixture.pattern.length]
  let idx = fixture.speakers.findIndex((s) => s.label === letter)
  if (idx < 0) idx = (letter.toUpperCase().charCodeAt(0) - 65) % fixture.speakers.length
  const embedding = new Array<number>(FIXTURE_DIM).fill(0)
  embedding[Math.max(0, idx)] = 1
  return [{ startMs: 0, endMs: durationMs, localSpeaker: idx, embedding }]
}

function defaultSpawn(): DiarizerWorkerHandle {
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), 'diarizer-worker.js')
  const child = utilityProcess.fork(modulePath, [], { serviceName: 'pitwall-diarizer', stdio: 'inherit' })
  return {
    post: (msg) => child.postMessage(msg),
    onMessage: (cb) => {
      child.on('message', (msg) => cb(msg as WorkerResponse))
    },
    onExit: (cb) => {
      child.on('exit', cb)
    },
    kill: () => {
      child.kill()
    },
  }
}

interface MeetingState {
  clusterer: MeetingClusterer
  /** speakerKey do clusterer → id persistido. */
  ids: Map<string, string>
  lastSpeakerKey: string | null
}

interface Pending {
  input: DiarizeChunkInput
  resolve: (turns: DiarizedTurn[]) => void
}

interface Worker {
  handle: DiarizerWorkerHandle
  ready: Promise<boolean>
  alive: boolean
  onResult: Map<number, (msg: WorkerResponse) => void>
}

function thresholdFrom(deps: DiarizerDeps, env: NodeJS.ProcessEnv): number {
  if (deps.threshold !== undefined) return deps.threshold
  const fromEnv = Number(env[SPEAKER_THRESHOLD_ENV])
  return Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 1 ? fromEnv : 0.6
}

export function createDiarizer(deps: DiarizerDeps = {}): MeetingDiarizer {
  const env = deps.env ?? process.env
  const log = deps.log ?? ((msg: string) => console.warn(`[diarizer] ${msg}`))
  const enabled = deps.enabled ?? true
  const fixture = deps.fixture === undefined ? loadDiarizeFixture(env) : deps.fixture
  const spawn = deps.spawnWorker ?? defaultSpawn
  const addonAvailable = deps.addonAvailable ?? sherpaAvailable
  const addonError = deps.addonError ?? sherpaLoadError
  const models = deps.models ?? resolveModels
  const timeoutMs = deps.timeoutMs ?? 8000
  const initTimeoutMs = deps.initTimeoutMs ?? 30_000
  const maxPending = deps.maxPending ?? 3
  const maxRestarts = deps.maxRestarts ?? 1
  const threshold = thresholdFrom(deps, env)

  const meetings = new Map<string, MeetingState>()
  const queue: Pending[] = []
  let inFlight: Pending | null = null
  let worker: Worker | null = null
  let restarts = 0
  let unavailableReason: string | null = null
  let loggedBackpressure = false
  let nextId = 1

  function markUnavailable(reason: string): void {
    if (unavailableReason) return
    unavailableReason = reason
    log(`diarização indisponível: ${reason}`)
  }

  function checkPrereqs(): boolean {
    if (unavailableReason) return false
    if (!addonAvailable()) {
      markUnavailable(addonError() ?? 'addon sherpa-onnx não carregou')
      return false
    }
    const paths = models()
    if (!paths.segmentation || !paths.embedding) {
      markUnavailable(
        !paths.segmentation ? 'modelo de segmentação ausente' : 'modelo de vozes (TitaNet) ainda não baixado',
      )
      return false
    }
    return true
  }

  function meetingState(meetingId: string): MeetingState {
    let state = meetings.get(meetingId)
    if (!state) {
      let known: KnownVoice[] = []
      try {
        known = (deps.store?.listVoices() ?? []).map((v) => ({ voiceId: v.id, name: v.name, embedding: v.embedding }))
      } catch (err) {
        log(`listVoices falhou, seguindo sem vozes conhecidas: ${err instanceof Error ? err.message : err}`)
      }
      state = { clusterer: createMeetingClusterer({ threshold, known }), ids: new Map(), lastSpeakerKey: null }
      meetings.set(meetingId, state)
    }
    return state
  }

  function clusterTurns(meetingId: string, turns: WorkerTurn[]): DiarizedTurn[] {
    const state = meetingState(meetingId)
    const out: DiarizedTurn[] = []
    const touched = new Set<string>()
    const created = new Set<string>()

    for (const turn of turns) {
      const durationSec = (turn.endMs - turn.startMs) / 1000
      const assigned = state.clusterer.assign(Float32Array.from(turn.embedding), durationSec)
      const key = assigned?.speakerKey ?? state.lastSpeakerKey
      if (!key) continue
      if (assigned?.isNew) {
        state.ids.set(key, randomUUID())
        created.add(key)
      }
      const id = state.ids.get(key)
      if (!id) continue
      touched.add(key)
      state.lastSpeakerKey = key
      const label = state.clusterer.centroids().find((c) => c.speakerKey === key)?.label ?? assigned?.label ?? ''
      out.push({ startMs: turn.startMs, endMs: turn.endMs, speakerId: id, speakerLabel: label })
    }

    if (deps.store && touched.size > 0) persist(meetingId, state, touched, created)
    return out
  }

  function persist(meetingId: string, state: MeetingState, touched: Set<string>, created: Set<string>): void {
    const store = deps.store!
    for (const c of state.clusterer.centroids()) {
      if (!touched.has(c.speakerKey)) continue
      const id = state.ids.get(c.speakerKey)!
      try {
        if (created.has(c.speakerKey)) {
          store.upsertSpeaker({
            id,
            meetingId,
            label: c.label,
            voiceId: c.voiceId,
            centroid: c.centroid,
            turnCount: c.turnCount,
          })
        } else {
          store.updateSpeaker({ id, centroid: c.centroid, turnCount: c.turnCount })
        }
      } catch (err) {
        log(`persistência de speaker falhou: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  function spawnWorker(): Worker {
    const handle = spawn()
    const w: Worker = { handle, alive: true, onResult: new Map(), ready: Promise.resolve(false) }
    let resolveReady: (ok: boolean) => void = () => {}
    w.ready = new Promise<boolean>((r) => {
      resolveReady = r
    })

    handle.onMessage((msg) => {
      if (msg.type === 'status') {
        if (msg.status === 'unavailable') {
          markUnavailable(msg.error ?? 'worker reportou indisponível')
          resolveReady(false)
        } else if (msg.status === 'ready') {
          resolveReady(true)
        }
        return
      }
      w.onResult.get(msg.id)?.(msg)
    })
    handle.onExit((code) => {
      if (!w.alive) return
      w.alive = false
      resolveReady(false)
      if (worker === w) worker = null
      for (const cb of w.onResult.values()) cb({ type: 'result', id: -1, error: `worker saiu (code ${code})` })
      w.onResult.clear()
      restarts += 1
      if (restarts > maxRestarts) markUnavailable(`worker caiu ${restarts}× (code ${code})`)
      else log(`worker caiu (code ${code}); respawn no próximo chunk`)
    })

    const paths = models()
    handle.post({ type: 'init', models: { segmentation: paths.segmentation!, embedding: paths.embedding! } })
    const initTimer = setTimeout(() => {
      markUnavailable(`worker não inicializou em ${initTimeoutMs} ms`)
      killWorker(w)
      resolveReady(false)
    }, initTimeoutMs)
    void w.ready.then(() => clearTimeout(initTimer))
    return w
  }

  function killWorker(w: Worker): void {
    if (!w.alive) return
    w.alive = false
    if (worker === w) worker = null
    // Quem esperava resposta deste worker nunca mais vai recebê-la.
    for (const cb of w.onResult.values()) cb({ type: 'result', id: -1, error: 'worker encerrado' })
    w.onResult.clear()
    try {
      w.handle.kill()
    } catch {
      // já morto
    }
  }

  async function ensureWorker(): Promise<Worker | null> {
    if (!checkPrereqs()) return null
    if (!worker) worker = spawnWorker()
    const w = worker
    const ok = await w.ready
    return ok && w.alive ? w : null
  }

  function runWorker(w: Worker, pcm: Buffer): Promise<WorkerTurn[] | null> {
    const id = nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        w.onResult.delete(id)
        log(`chunk excedeu ${timeoutMs} ms; reiniciando o worker`)
        // Worker travado não responde a mais nada: derruba e conta como queda.
        killWorker(w)
        restarts += 1
        if (restarts > maxRestarts) markUnavailable('worker travou de novo após reinício')
        resolve(null)
      }, timeoutMs)
      w.onResult.set(id, (msg) => {
        clearTimeout(timer)
        w.onResult.delete(id)
        if ('error' in msg) {
          log(`worker falhou no chunk: ${msg.error}`)
          resolve(null)
        } else {
          resolve(msg.turns)
        }
      })
      w.handle.post({ type: 'diarize', id, pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) })
    })
  }

  async function pump(): Promise<void> {
    if (inFlight) return
    const next = queue.shift()
    if (!next) return
    inFlight = next
    try {
      const w = await ensureWorker()
      const turns = w ? await runWorker(w, next.input.pcm) : null
      next.resolve(turns ? clusterTurns(next.input.meetingId, turns) : [])
    } catch (err) {
      log(`falha inesperada na diarização: ${err instanceof Error ? err.message : err}`)
      next.resolve([])
    } finally {
      inFlight = null
      void pump()
    }
  }

  return {
    process(input) {
      if (!enabled) return Promise.resolve([])
      if (fixture) {
        const durationMs = Math.round((input.pcm.length / 2 / SAMPLE_RATE) * 1000)
        return Promise.resolve(clusterTurns(input.meetingId, fixtureTurns(fixture, input.chunkIndex, durationMs)))
      }
      if (!checkPrereqs()) return Promise.resolve([])
      const pending = queue.length + (inFlight ? 1 : 0)
      if (pending >= maxPending) {
        if (!loggedBackpressure) {
          loggedBackpressure = true
          log(`fila cheia (${pending}); descartando diarização de chunks atrasados (STT segue)`)
        }
        return Promise.resolve([])
      }
      return new Promise<DiarizedTurn[]>((resolve) => {
        queue.push({ input, resolve })
        void pump()
      })
    },
    status() {
      if (!enabled) return 'off'
      if (fixture) return 'on'
      if (!checkPrereqs()) return 'unavailable'
      return worker?.alive && restarts <= maxRestarts ? 'on' : 'loading'
    },
    reset(meetingId) {
      meetings.delete(meetingId)
    },
    async warmup() {
      if (!enabled || fixture) return
      await ensureWorker()
    },
    dispose() {
      if (worker) killWorker(worker)
      meetings.clear()
      queue.splice(0).forEach((p) => p.resolve([]))
    },
  }
}
