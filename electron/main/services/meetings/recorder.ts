import type { Meeting, MeetingEvent, MeetingLiveState, MeetingSetupStatus } from '../../../../shared/types/meetings'
import { notify as defaultNotify } from '../notifications'
import { emitMeetingEvent } from './event-bus'
import { clearVoiceSecrets } from '../voice-config'
import { hasPipewire, resolveDefaultDevices } from './audio-devices'
import {
  fixtureFromEnv,
  fixturePaceFromEnv,
  startCapture,
  type CaptureHandle,
  type Track,
} from './audio-capture'
import * as meetingStore from './meeting-store'
import { PcmChunker, rmsLinear, type Chunk } from './pcm-chunker'
import {
  postProcessRegistry,
  recorderRegistry,
  setupCheckRegistry,
  type MeetingRecorder,
} from './recorder-contract'
import { loadSttConfig, SttError, transcribeChunk, type SttConfig, type SttConfigResult } from './transcriber'
import { encodeWav } from './wav'

// Orquestra uma gravação: duas capturas (me/them) → chunker por trilha → STT
// (uma chamada em voo por trilha) → segmentos no store + broadcast pro
// renderer. O áudio nunca toca o disco: PCM em memória, WAV só no corpo do POST.

const TRACKS: Track[] = ['me', 'them']
const OVERLAP_MS = 1000
const PROMPT_WORDS = 150
const AUTO_STOP_MS = 15 * 60_000
const STT_DRAIN_TIMEOUT_MS = 30_000
const LEVEL_INTERVAL_MS = 250
const STATE_THROTTLE_MS = 250

export interface RecorderDeps {
  store: Pick<typeof meetingStore, 'create' | 'get' | 'update' | 'setStatus' | 'appendSegment'>
  startCapture: typeof startCapture
  transcribeChunk: typeof transcribeChunk
  loadSttConfig: () => Promise<SttConfigResult>
  resolveDefaultDevices: () => Promise<{ sink: string | null; source: string | null }>
  hasPipewire: () => Promise<boolean>
  broadcast: (channel: string, payload: unknown) => void
  notify: (input: { title: string; body: string }) => void
  env: NodeJS.ProcessEnv
  now: () => number
  autoStopMs: number
  sttDrainTimeoutMs: number
  levelIntervalMs: number
}

export type Recorder = MeetingRecorder & { checkSetup(): Promise<MeetingSetupStatus> }

interface TrackState {
  track: Track
  capture: CaptureHandle | null
  chunker: PcmChunker
  queue: Chunk[]
  inFlight: boolean
  /** Palavras já transcritas — as últimas ~150 vão de prompt pro próximo chunk. */
  words: string[]
  respawned: boolean
  /** Maior RMS de bloco desde o último tick de níveis. */
  peak: number
}

interface Session {
  meetingId: string
  startedAt: number
  captureMode: MeetingLiveState['captureMode']
  targets: { sink: string | null; source: string | null }
  pace: number
  tracks: Record<Track, TrackState>
  sttConfig: SttConfig | null
  sttOk: boolean
  lastError: string | null
  sttNotified: boolean
  lastVoiceAt: number
  levels: { me: number; them: number }
  levelTimer: NodeJS.Timeout | null
  lastStateBroadcast: number
  stopping: Promise<Meeting> | null
  /** Captura morreu de vez: stop() encerra com status 'error'. */
  fatal: string | null
}

function defaultDeps(): RecorderDeps {
  return {
    store: meetingStore,
    startCapture,
    transcribeChunk,
    loadSttConfig: () => loadSttConfig(),
    resolveDefaultDevices: () => resolveDefaultDevices(),
    hasPipewire: () => hasPipewire(),
    broadcast: (_channel, payload) => emitMeetingEvent(payload as MeetingEvent),
    notify: defaultNotify,
    env: process.env,
    now: Date.now,
    autoStopMs: AUTO_STOP_MS,
    sttDrainTimeoutMs: STT_DRAIN_TIMEOUT_MS,
    levelIntervalMs: LEVEL_INTERVAL_MS,
  }
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createRecorder(overrides: Partial<RecorderDeps> = {}): Recorder {
  const deps: RecorderDeps = { ...defaultDeps(), ...overrides }
  let session: Session | null = null
  let starting = false

  const emit = (event: unknown): void => deps.broadcast('meetings:event', event)

  const activeMeeting = (): Meeting | null =>
    session ? (deps.store.get(session.meetingId)?.meeting ?? null) : null

  const getState = (): MeetingLiveState => ({
    active: activeMeeting(),
    elapsedMs: session ? deps.now() - session.startedAt : 0,
    levels: session ? { ...session.levels } : { me: 0, them: 0 },
    sttOk: session ? session.sttOk : true,
    lastError: session?.lastError ?? null,
    captureMode: session?.captureMode ?? 'pipewire',
  })

  const broadcastState = (force = false): void => {
    const now = deps.now()
    if (session && !force && now - session.lastStateBroadcast < STATE_THROTTLE_MS) return
    if (session) session.lastStateBroadcast = now
    emit({ type: 'state', state: getState() })
  }

  const sttFailed = (s: Session, message: string): void => {
    s.sttOk = false
    s.lastError = message
    if (!s.sttNotified) {
      s.sttNotified = true
      deps.notify({ title: 'Transcrição indisponível', body: message })
    }
    broadcastState(true)
  }

  const ensureStt = async (s: Session): Promise<SttConfig | null> => {
    if (s.sttConfig) return s.sttConfig
    const result = await deps.loadSttConfig()
    if (!result.ok) {
      sttFailed(s, result.error)
      return null
    }
    s.sttConfig = result.cfg
    return result.cfg
  }

  const transcribe = async (s: Session, t: TrackState, chunk: Chunk): Promise<void> => {
    const cfg = await ensureStt(s)
    if (!cfg) return
    const prompt = t.words.length ? t.words.slice(-PROMPT_WORDS).join(' ') : cfg.vocabulary || undefined
    try {
      const segments = await deps.transcribeChunk({
        wav: encodeWav(chunk.pcm),
        language: cfg.language,
        prompt,
        config: cfg,
        durationMs: chunk.endMs - chunk.startMs,
      })
      if (!s.sttOk) {
        s.sttOk = true
        s.lastError = null
        broadcastState(true)
      }
      for (const seg of segments) {
        // O 1 s de overlap já foi transcrito no chunk anterior: segmento que
        // termina dentro dele é repetição.
        if (chunk.index > 0 && seg.endMs <= OVERLAP_MS) continue
        const segment = deps.store.appendSegment({
          meetingId: s.meetingId,
          speaker: t.track,
          text: seg.text,
          startMs: chunk.startMs + seg.startMs,
          endMs: chunk.startMs + seg.endMs,
          chunkIndex: chunk.index,
        })
        t.words.push(...seg.text.split(/\s+/))
        if (t.words.length > PROMPT_WORDS * 2) t.words = t.words.slice(-PROMPT_WORDS)
        emit({ type: 'segment', segment })
      }
    } catch (err) {
      // 401/403 pode ser secret cacheado que venceu: o próximo chunk recarrega.
      if (err instanceof SttError && (err.status === 401 || err.status === 403)) {
        clearVoiceSecrets()
        s.sttConfig = null
      }
      sttFailed(s, errorText(err))
    }
  }

  const pump = (s: Session, t: TrackState): void => {
    if (t.inFlight) return
    const chunk = t.queue.shift()
    if (!chunk) return
    t.inFlight = true
    void transcribe(s, t, chunk).finally(() => {
      t.inFlight = false
      pump(s, t)
    })
  }

  const enqueue = (s: Session, t: TrackState, chunk: Chunk): void => {
    if (chunk.silent) return
    s.lastVoiceAt = deps.now()
    t.queue.push(chunk)
    pump(s, t)
  }

  const onPcm = (s: Session, t: TrackState, pcm: Buffer): void => {
    if (s.stopping) return
    t.peak = Math.max(t.peak, rmsLinear(pcm))
    for (const chunk of t.chunker.push(pcm)) enqueue(s, t, chunk)
  }

  const openCapture = (s: Session, t: TrackState): void => {
    const handle = deps.startCapture({
      track: t.track,
      target: t.track === 'them' ? s.targets.sink : s.targets.source,
      fixturePath: fixtureFromEnv(t.track, deps.env),
      mode: s.captureMode,
      pace: s.pace,
    })
    t.capture = handle
    handle.onData((pcm) => onPcm(s, t, pcm))
    handle.onExit((code, stderr) => {
      if (s.stopping || t.capture !== handle) return
      const message = `pw-record (${t.track}) saiu com código ${code}${stderr ? ': ' + stderr : ''}`
      s.lastError = message
      if (!t.respawned) {
        t.respawned = true
        try {
          openCapture(s, t)
          broadcastState(true)
          return
        } catch (err) {
          s.lastError = `${message}; respawn falhou: ${errorText(err)}`
        }
      }
      s.fatal = s.lastError
      void stop().catch(() => {})
    })
  }

  const tick = (s: Session): void => {
    for (const track of TRACKS) {
      s.levels[track] = Math.min(1, s.tracks[track].peak)
      s.tracks[track].peak = 0
    }
    broadcastState()
    if (!s.stopping && deps.now() - s.lastVoiceAt >= deps.autoStopMs) {
      void stop()
        .then(() => deps.notify({ title: 'Gravação encerrada', body: '15 minutos sem áudio' }))
        .catch(() => {})
    }
  }

  const drain = (s: Session): Promise<void> =>
    new Promise((resolve) => {
      const deadline = deps.now() + deps.sttDrainTimeoutMs
      const idle = (): boolean => TRACKS.every((track) => !s.tracks[track].inFlight && s.tracks[track].queue.length === 0)
      const check = (): void => {
        if (idle() || deps.now() >= deadline) {
          clearInterval(timer)
          resolve()
        }
      }
      const timer = setInterval(check, 25)
      check()
    })

  const finish = async (s: Session): Promise<Meeting> => {
    if (s.levelTimer) clearInterval(s.levelTimer)
    for (const track of TRACKS) {
      const t = s.tracks[track]
      t.capture?.stop()
      for (const chunk of t.chunker.flush()) enqueue(s, t, chunk)
    }
    await drain(s)

    const endedAt = deps.now()
    let meeting = s.fatal
      ? deps.store.setStatus(s.meetingId, 'error', { endedAt, error: s.fatal })
      : deps.store.setStatus(s.meetingId, 'processing', { endedAt })
    session = null
    broadcastState(true)
    emit({ type: 'meeting', meeting })
    if (meeting.status === 'error') return meeting

    const post = postProcessRegistry.current
    if (post) {
      post(meeting.id).catch((err: unknown) => {
        const failed = deps.store.setStatus(meeting.id, 'error', { error: errorText(err) })
        emit({ type: 'meeting', meeting: failed })
      })
      return meeting
    }
    meeting = deps.store.setStatus(meeting.id, 'done')
    emit({ type: 'meeting', meeting })
    return meeting
  }

  const stop = (): Promise<Meeting> => {
    if (!session) return Promise.reject(new Error('Nenhuma gravação em andamento'))
    if (!session.stopping) session.stopping = finish(session)
    return session.stopping
  }

  const start = async ({ title }: { title?: string }): Promise<Meeting> => {
    if (session || starting) throw new Error('Já existe uma gravação em andamento')
    starting = true
    try {
      const fixture = TRACKS.some((track) => fixtureFromEnv(track, deps.env))
      const captureMode = fixture ? 'fixture' : 'pipewire'
      const targets = fixture ? { sink: null, source: null } : await deps.resolveDefaultDevices()
      const meeting = deps.store.create({ title })
      const startedAt = deps.now()
      const s: Session = {
        meetingId: meeting.id,
        startedAt,
        captureMode,
        targets,
        pace: fixturePaceFromEnv(deps.env),
        tracks: {
          me: newTrack('me'),
          them: newTrack('them'),
        },
        sttConfig: null,
        sttOk: true,
        lastError: null,
        sttNotified: false,
        lastVoiceAt: startedAt,
        levels: { me: 0, them: 0 },
        levelTimer: null,
        lastStateBroadcast: 0,
        stopping: null,
        fatal: null,
      }
      session = s
      try {
        for (const track of TRACKS) openCapture(s, s.tracks[track])
      } catch (err) {
        for (const track of TRACKS) s.tracks[track].capture?.stop()
        session = null
        const message = `Falha ao iniciar captura: ${errorText(err)}`
        deps.store.setStatus(meeting.id, 'error', { endedAt: deps.now(), error: message })
        throw new Error(message)
      }
      s.levelTimer = setInterval(() => tick(s), deps.levelIntervalMs)
      // Config do STT já na largada: erro aparece antes do primeiro chunk.
      void ensureStt(s)
      emit({ type: 'meeting', meeting })
      broadcastState(true)
      return meeting
    } finally {
      starting = false
    }
  }

  const appendQuickNote = (meetingId: string, text: string): Meeting => {
    const detail = deps.store.get(meetingId)
    if (!detail) throw new Error(`Reunião não encontrada: ${meetingId}`)
    const trimmed = text.trim()
    if (!trimmed) return detail.meeting
    const { meeting } = detail
    const elapsed =
      session?.meetingId === meetingId
        ? deps.now() - session.startedAt
        : (meeting.endedAt ?? deps.now()) - meeting.startedAt
    const line = `- [${mmss(elapsed)}] ${trimmed}`
    const rawNotes = meeting.rawNotes ? `${meeting.rawNotes}\n${line}` : line
    const updated = deps.store.update({ id: meetingId, rawNotes })
    emit({ type: 'meeting', meeting: updated })
    return updated
  }

  const checkSetup = async (): Promise<MeetingSetupStatus> => {
    const [pipewire, devices, stt] = await Promise.all([
      deps.hasPipewire(),
      deps.resolveDefaultDevices(),
      deps.loadSttConfig(),
    ])
    return {
      pipewire,
      sink: devices.sink,
      source: devices.source,
      stt: stt.ok ? { ok: true, url: stt.cfg.url, error: null } : { ok: false, url: stt.url, error: stt.error },
    }
  }

  return { start, stop, getState, appendQuickNote, checkSetup }
}

function newTrack(track: Track): TrackState {
  return {
    track,
    capture: null,
    chunker: new PcmChunker(),
    queue: [],
    inFlight: false,
    words: [],
    respawned: false,
    peak: 0,
  }
}

export function installRecorder(): Recorder {
  const recorder = createRecorder()
  recorderRegistry.current = recorder
  setupCheckRegistry.current = () => recorder.checkSetup()
  return recorder
}
