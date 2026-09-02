import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { MeetingDetection, MeetingDetectionAction, MeetingLiveState } from '../../../../shared/types/meetings'
import { notify as defaultNotify } from '../notifications'
import { getPref as defaultGetPref } from '../prefs-store'
import { hasPipewire as defaultHasPipewire, type Exec } from './audio-devices'
import { detectorRegistry, recorderRegistry } from './recorder-contract'
import { startRecording as defaultStartRecording, stopRecording as defaultStopRecording } from './recording-actions'

// Detecção de reunião: faz poll do `pw-dump` e procura streams de captura de
// microfone (`Stream/Input/Audio` em `running`) abertos por apps de chamada.
// O binário/pid do app NÃO ficam no nó — ficam no objeto Client apontado por
// `client.id`; daí o join. Um candidato por vez, com histerese nos dois
// sentidos (detectMs pra confirmar, endMs pra dar por encerrado) porque o
// Chrome abre/fecha o stream várias vezes numa chamada.

export const AUTO_DETECT_KEY = 'meeting_auto_detect'
export const AUTO_RECORD_KEY = 'meeting_auto_record'
export const DETECT_SCRIPT_ENV = 'CM_MEETING_DETECT_SCRIPT'

// 2 s de poll + 3 s de detectMs = pior caso ~7 s até o banner; pw-dump custa ~12 ms.
const POLL_MS = 2000
const DETECT_MS = 3000
const END_MS = 8000
const GRACE_MS = 8000
const BACKOFF_MS = 30_000
const MAX_FAILURES = 3

// Streams do próprio Pitwall (pw-record da gravação, captura de voz do
// renderer) — sem isso o app detectaria a si mesmo ao gravar.
export const DEFAULT_DENY_LIST: ReadonlySet<string> = new Set([
  'pw-cat',
  'pw-record',
  'pw-play',
  'pitwall',
  'electron',
  'claude-manager',
  basename(process.execPath),
])

export interface DetectedStream {
  clientId: number
  /** Menor id de nó do grupo do client. */
  streamId: number
  binary: string
  pid: number | null
  app: string
  label: string
}

interface PwObject {
  id?: unknown
  type?: unknown
  info?: { state?: unknown; props?: Record<string, unknown> }
}

const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

const BROWSERS = new Set(['chrome', 'chromium', 'brave', 'msedge', 'firefox'])
const NAMED: Record<string, string> = { zoom: 'Zoom', teams: 'Teams', slack: 'Slack', discord: 'Discord' }

export function labelFor(binary: string, app: string): string {
  const key = binary.toLowerCase()
  if (BROWSERS.has(key)) return `navegador (${app || binary})`
  if (NAMED[key]) return NAMED[key]
  return app || binary
}

export function parseDump(json: unknown, denyList: ReadonlySet<string> = DEFAULT_DENY_LIST): DetectedStream[] {
  if (!Array.isArray(json)) return []
  const objects = json as PwObject[]

  const clients = new Map<number, { binary: string; pid: number | null; app: string }>()
  for (const o of objects) {
    if (o.type !== 'PipeWire:Interface:Client') continue
    const id = asNumber(o.id)
    const props = o.info?.props ?? {}
    if (id === null) continue
    clients.set(id, {
      binary: asString(props['application.process.binary']),
      pid: asNumber(props['application.process.id']),
      app: asString(props['application.name']),
    })
  }

  const byClient = new Map<number, DetectedStream>()
  for (const o of objects) {
    if (o.type !== 'PipeWire:Interface:Node' || o.info?.state !== 'running') continue
    const props = o.info.props ?? {}
    if (props['media.class'] !== 'Stream/Input/Audio') continue
    const nodeId = asNumber(o.id)
    const clientId = asNumber(props['client.id'])
    if (nodeId === null || clientId === null) continue
    const client = clients.get(clientId)
    if (!client || !client.binary || denyList.has(client.binary)) continue
    const existing = byClient.get(clientId)
    if (existing) {
      if (nodeId < existing.streamId) byClient.set(clientId, { ...existing, streamId: nodeId })
      continue
    }
    byClient.set(clientId, {
      clientId,
      streamId: nodeId,
      binary: client.binary,
      pid: client.pid,
      app: client.app,
      label: labelFor(client.binary, client.app),
    })
  }
  return [...byClient.values()].sort((a, b) => a.streamId - b.streamId)
}

// Timeline sintética pro e2e: "2:chrome,25:none" = a partir de 2 s um Client
// `chrome` com stream running; a partir de 25 s, dump vazio.
export interface ScriptStep {
  atMs: number
  binary: string | null
}

export function parseScript(raw: string): ScriptStep[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [secs, binary] = part.split(':')
      const at = Number(secs)
      if (!Number.isFinite(at) || !binary) throw new Error(`${DETECT_SCRIPT_ENV} inválido: "${part}"`)
      return { atMs: at * 1000, binary: binary === 'none' ? null : binary }
    })
    .sort((a, b) => a.atMs - b.atMs)
}

export function scriptDump(steps: ScriptStep[], elapsedMs: number): unknown[] {
  let index = -1
  for (let i = 0; i < steps.length; i++) if (steps[i].atMs <= elapsedMs) index = i
  if (index < 0 || steps[index].binary === null) return []
  const binary = steps[index].binary as string
  const clientId = 1000 + index * 2
  return [
    {
      id: clientId,
      type: 'PipeWire:Interface:Client',
      info: {
        props: {
          'application.name': binary,
          'application.process.binary': binary,
          'application.process.id': 50_000 + index,
        },
      },
    },
    {
      id: clientId + 1,
      type: 'PipeWire:Interface:Node',
      info: { state: 'running', props: { 'media.class': 'Stream/Input/Audio', 'client.id': clientId } },
    },
  ]
}

export interface DetectorDeps {
  exec: Exec
  pollMs: number
  detectMs: number
  endMs: number
  graceMs: number
  backoffMs: number
  now: () => number
  getPref: <T>(key: string, fallback: T) => T
  notify: (input: { title: string; body: string; onClick?: () => void }) => void
  startRecording: () => Promise<void>
  stopRecording: () => Promise<void>
  getRecorderState: () => Pick<MeetingLiveState, 'active' | 'linkedStreamId'>
  refreshState: () => void
  hasPipewire: () => Promise<boolean>
  env: NodeJS.ProcessEnv
  log: (message: string, err?: unknown) => void
}

const execFileAsync = promisify(execFile)

function defaultDeps(): DetectorDeps {
  return {
    exec: (cmd, args) =>
      execFileAsync(cmd, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }) as Promise<{ stdout: string }>,
    pollMs: POLL_MS,
    detectMs: DETECT_MS,
    endMs: END_MS,
    graceMs: GRACE_MS,
    backoffMs: BACKOFF_MS,
    now: Date.now,
    getPref: defaultGetPref,
    notify: defaultNotify,
    startRecording: defaultStartRecording,
    stopRecording: defaultStopRecording,
    getRecorderState: () => recorderRegistry.current?.getState() ?? { active: null, linkedStreamId: null },
    refreshState: () => recorderRegistry.current?.refreshState(),
    hasPipewire: () => defaultHasPipewire(),
    env: process.env,
    log: (message, err) => console.warn(`[meeting-detect] ${message}`, err ?? ''),
  }
}

export type DetectorPhase = 'idle' | 'pending' | 'detected' | 'ending' | 'ended'

interface Tracked {
  stream: DetectedStream
  /** Todos os node ids que este client já usou — o vínculo da gravação vale pra qualquer um. */
  streamIds: Set<number>
  phase: DetectorPhase
  firstSeenAt: number
  absentSince: number
  ignored: boolean
  /** Gravação vinculada estava ativa no último poll (pra flagrar stop manual). */
  linkedActive: boolean
}

export interface Detector {
  start(): void
  stop(): void
  getDetection(): MeetingDetection | null
  decide(action: MeetingDetectionAction): void
  _state(): { phase: DetectorPhase; clientId: number | null; streamId: number | null; ignored: boolean; failures: number }
}

export function createDetector(overrides: Partial<DetectorDeps> = {}): Detector {
  const deps: DetectorDeps = { ...defaultDeps(), ...overrides }
  const script = deps.env[DETECT_SCRIPT_ENV] ? parseScript(deps.env[DETECT_SCRIPT_ENV] as string) : null

  let running = false
  let startedAt = 0
  let pollTimer: NodeJS.Timeout | null = null
  let graceTimer: NodeJS.Timeout | null = null
  let tracked: Tracked | null = null
  let failures = 0
  let backoffLogged = false

  const readDump = async (): Promise<unknown> => {
    if (script) return scriptDump(script, deps.now() - startedAt)
    const { stdout } = await deps.exec('pw-dump', [])
    return JSON.parse(stdout) as unknown
  }

  const getDetection = (): MeetingDetection | null => {
    if (!tracked || (tracked.phase !== 'detected' && tracked.phase !== 'ending')) return null
    const { stream } = tracked
    return {
      app: stream.label,
      binary: stream.binary,
      pid: stream.pid ?? 0,
      streamId: stream.streamId,
      since: tracked.firstSeenAt,
      ignored: tracked.ignored,
    }
  }

  const transition = (phase: DetectorPhase): void => {
    if (tracked) tracked.phase = phase
    deps.refreshState()
  }

  const isLinked = (ids: Set<number>): boolean => {
    const state = deps.getRecorderState()
    return Boolean(state.active) && state.linkedStreamId !== null && ids.has(state.linkedStreamId)
  }

  const decide = (action: MeetingDetectionAction): void => {
    if (!tracked) return
    if (action === 'ignore') {
      tracked.ignored = true
      deps.refreshState()
      return
    }
    if (deps.getRecorderState().active) return
    void deps.startRecording().catch((err: unknown) => deps.log('startRecording falhou', err))
  }

  const detected = (t: Tracked): void => {
    transition('detected')
    // Já gravando (manual ou vinculado a outro stream): nada a oferecer.
    if (deps.getRecorderState().active) return
    if (deps.getPref(AUTO_RECORD_KEY, false)) {
      void deps.startRecording().catch((err: unknown) => deps.log('auto-record falhou', err))
      deps.notify({ title: 'Gravando reunião detectada', body: `${t.stream.label} está usando o microfone.` })
      return
    }
    deps.notify({
      title: 'Reunião detectada',
      body: `${t.stream.label} está usando o microfone. Clique para gravar.`,
      onClick: () => decide('record'),
    })
  }

  const ended = (t: Tracked): void => {
    tracked = null
    transition('ended')
    if (!isLinked(t.streamIds)) return
    if (graceTimer) clearTimeout(graceTimer)
    graceTimer = setTimeout(() => {
      graceTimer = null
      if (tracked || !isLinked(t.streamIds)) return
      void deps
        .stopRecording()
        .then(() => deps.notify({ title: 'Gravação encerrada', body: 'A chamada terminou.' }))
        .catch((err: unknown) => deps.log('auto-stop falhou', err))
    }, deps.graceMs)
  }

  // Gravação vinculada que sumiu sem o stream ter acabado = parada manual.
  const checkManualStop = (t: Tracked): void => {
    const linkedNow = isLinked(t.streamIds)
    if (t.linkedActive && !linkedNow && !t.ignored) {
      t.ignored = true
      deps.refreshState()
    }
    t.linkedActive = linkedNow
  }

  const tick = (candidates: DetectedStream[]): void => {
    const now = deps.now()
    if (!tracked) {
      const first = candidates[0]
      if (!first) return
      tracked = {
        stream: first,
        streamIds: new Set([first.streamId]),
        phase: 'idle',
        firstSeenAt: now,
        absentSince: 0,
        ignored: false,
        linkedActive: false,
      }
      transition('pending')
      return
    }

    const t = tracked
    const seen = candidates.find((c) => c.clientId === t.stream.clientId) ?? null
    if (seen && seen.streamId !== t.stream.streamId) {
      t.stream = seen
      t.streamIds.add(seen.streamId)
    }
    checkManualStop(t)

    switch (t.phase) {
      case 'pending':
        if (!seen) {
          tracked = null
          transition('idle')
        } else if (now - t.firstSeenAt >= deps.detectMs) {
          detected(t)
        }
        return
      case 'detected':
        if (!seen) {
          t.absentSince = now
          transition('ending')
        }
        return
      case 'ending':
        if (seen) transition('detected')
        else if (now - t.absentSince >= deps.endMs) ended(t)
        return
      default:
        return
    }
  }

  const schedule = (ms: number): void => {
    if (!running) return
    pollTimer = setTimeout(() => void poll(), ms)
  }

  const poll = async (): Promise<void> => {
    pollTimer = null
    if (!running) return
    let dump: unknown
    try {
      dump = await readDump()
    } catch (err) {
      // Falha congela o estado: nada transita até o próximo dump bom.
      failures++
      if (failures >= MAX_FAILURES && !backoffLogged) {
        backoffLogged = true
        deps.log(`pw-dump falhou ${failures}x seguidas; tentando de novo em ${deps.backoffMs / 1000}s`, err)
      }
      schedule(failures >= MAX_FAILURES ? deps.backoffMs : deps.pollMs)
      return
    }
    failures = 0
    backoffLogged = false
    if (!running) return
    try {
      tick(parseDump(dump))
    } catch (err) {
      deps.log('tick falhou', err)
    }
    schedule(deps.pollMs)
  }

  const start = (): void => {
    if (running) return
    if (!deps.getPref(AUTO_DETECT_KEY, true)) return
    running = true
    startedAt = deps.now()
    const ready = script ? Promise.resolve(true) : deps.hasPipewire()
    void ready.then((ok) => {
      if (!running) return
      if (!ok) {
        running = false
        return
      }
      schedule(0)
    })
  }

  const stop = (): void => {
    running = false
    if (pollTimer) clearTimeout(pollTimer)
    if (graceTimer) clearTimeout(graceTimer)
    pollTimer = null
    graceTimer = null
    failures = 0
    backoffLogged = false
    if (tracked) {
      tracked = null
      deps.refreshState()
    }
  }

  const _state = (): ReturnType<Detector['_state']> => ({
    phase: tracked?.phase ?? 'idle',
    clientId: tracked?.stream.clientId ?? null,
    streamId: tracked?.stream.streamId ?? null,
    ignored: tracked?.ignored ?? false,
    failures,
  })

  const detector: Detector = { start, stop, getDetection, decide, _state }
  detectorRegistry.current = { getDetection, decide }
  return detector
}

// Ciclo de vida no app (molde repo-pull-scheduler): boot, toggle da pref e quit.
let installed: Detector | null = null

export function installDetector(): void {
  if (!installed) installed = createDetector()
  installed.start()
}

export function rescheduleDetector(): void {
  if (!installed) return
  installed.stop()
  installed.start()
}

export function uninstallDetector(): void {
  installed?.stop()
  installed = null
  detectorRegistry.current = null
}
