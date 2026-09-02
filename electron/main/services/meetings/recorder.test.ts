/** @vitest-environment node */
// Recorder com captura em modo fixture (pace 0), STT mockado e store real em
// tmpdir — mesma estratégia de meeting-store.test.ts.
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'meeting-recorder-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
    Notification: { isSupported: () => false },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import * as store from './meeting-store'
import { detectorRegistry, postProcessRegistry } from './recorder-contract'
import { createRecorder, type RecorderDeps } from './recorder'
import { SttError, type SttConfig, type TranscribeChunkInput } from './transcriber'

const fixtures = resolve(__dirname, '../../../../e2e/fixtures/meetings')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const sttConfig: SttConfig = { url: 'https://stt/v1', model: 'whisper', language: 'pt', vocabulary: '', key: 'k' }

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

beforeEach(() => {
  getDb().exec('DELETE FROM meeting_v2_action_items; DELETE FROM meeting_v2_segments; DELETE FROM meetings_v2;')
})

afterEach(() => {
  postProcessRegistry.current = null
  detectorRegistry.current = null
})

function fixtureEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CM_MEETING_FIXTURE_SYSTEM: resolve(fixtures, 'system-participante.wav'),
    CM_MEETING_FIXTURE_MIC: resolve(fixtures, 'mic-eu.wav'),
    CM_MEETING_FIXTURE_PACE: '0',
    ...over,
  }
}

// Um segmento por chunk, com timestamps relativos ao chunk; o texto carrega o
// tamanho do WAV pra dar pra conferir que o áudio certo foi enviado.
function fakeStt() {
  return vi.fn(async (input: TranscribeChunkInput) => [
    { text: `fala ${input.wav.length}`, startMs: 500, endMs: 1500, noSpeechProb: 0.1 },
  ])
}

function build(over: Partial<RecorderDeps> = {}) {
  const broadcast = vi.fn()
  const notify = vi.fn()
  const transcribe = fakeStt()
  const recorder = createRecorder({
    broadcast,
    notify,
    transcribeChunk: transcribe as unknown as RecorderDeps['transcribeChunk'],
    loadSttConfig: async () => ({ ok: true, cfg: sttConfig }),
    resolveDefaultDevices: async () => ({ sink: 'sink.x', source: 'source.x' }),
    hasPipewire: async () => true,
    env: fixtureEnv(),
    levelIntervalMs: 20,
    ...over,
  })
  return { recorder, broadcast, notify, transcribe }
}

function events(broadcast: ReturnType<typeof vi.fn>, type: string) {
  return broadcast.mock.calls
    .filter(([channel, payload]) => channel === 'meetings:event' && (payload as { type: string }).type === type)
    .map(([, payload]) => payload as Record<string, unknown>)
}

describe('start → segmentos → stop', () => {
  it('transcreve as duas trilhas com speakers e offsets absolutos e termina em done', async () => {
    const { recorder, broadcast, transcribe } = build()

    const meeting = await recorder.start({ title: 'Daily' })
    expect(meeting.status).toBe('recording')
    expect(recorder.getState()).toMatchObject({ captureMode: 'fixture', sttOk: true, lastError: null })
    expect(recorder.getState().active?.id).toBe(meeting.id)

    await sleep(60)
    const done = await recorder.stop()
    expect(done.status).toBe('done')
    expect(done.endedAt).not.toBeNull()
    expect(recorder.getState().active).toBeNull()

    const segments = store.listSegments(meeting.id)
    const me = segments.filter((s) => s.speaker === 'me')
    const them = segments.filter((s) => s.speaker === 'them')
    expect(me.length).toBeGreaterThanOrEqual(1)
    // 38 s de sistema → pelo menos dois chunks antes do flush
    expect(them.length).toBeGreaterThanOrEqual(2)
    expect(them[0].startMs).toBe(500)
    expect(them[1].startMs).toBeGreaterThan(10_000)
    expect(them[1].chunkIndex).toBe(1)
    for (const s of segments) expect(s.endMs - s.startMs).toBe(1000)

    // prompt = transcript anterior da mesma trilha
    const prompts = transcribe.mock.calls.map(([input]) => input.prompt)
    expect(prompts[0]).toBeUndefined()
    expect(prompts.some((p) => p?.startsWith('fala '))).toBe(true)
    for (const [input] of transcribe.mock.calls) {
      expect(input.wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
      expect(input.language).toBe('pt')
    }

    expect(events(broadcast, 'segment')).toHaveLength(segments.length)
    const meetingEvents = events(broadcast, 'meeting').map((e) => (e.meeting as { status: string }).status)
    expect(meetingEvents).toEqual(['recording', 'processing', 'done'])
    const states = events(broadcast, 'state')
    expect(states.length).toBeGreaterThan(0)
    expect(store.get(meeting.id)?.meeting.segmentCount).toBe(segments.length)
  })

  it('recusa start com gravação em andamento', async () => {
    const { recorder } = build()
    await recorder.start({})
    await expect(recorder.start({})).rejects.toThrow('Já existe uma gravação em andamento')
    await recorder.stop()
    await expect(recorder.stop()).rejects.toThrow('Nenhuma gravação em andamento')
  })

  it('com post-process registrado fica em processing e delega o done', async () => {
    const post = vi.fn(async () => {})
    postProcessRegistry.current = post
    const { recorder } = build()
    const meeting = await recorder.start({})
    await sleep(20)
    const stopped = await recorder.stop()
    expect(stopped.status).toBe('processing')
    expect(post).toHaveBeenCalledWith(meeting.id)
  })
})

describe('STT falha', () => {
  it('sttOk=false com lastError, notifica uma vez e a gravação segue até done', async () => {
    const failing = vi.fn(async () => {
      throw new SttError('o serviço de transcrição falhou (HTTP 500)', 500)
    })
    const { recorder, notify } = build({
      transcribeChunk: failing as unknown as RecorderDeps['transcribeChunk'],
    })
    const meeting = await recorder.start({})
    await sleep(60)

    const state = recorder.getState()
    expect(state.active?.id).toBe(meeting.id)
    expect(state.sttOk).toBe(false)
    expect(state.lastError).toMatch(/HTTP 500/)
    expect(failing.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith({ title: 'Transcrição indisponível', body: expect.stringMatching(/HTTP 500/) })

    const done = await recorder.stop()
    expect(done.status).toBe('done')
    expect(store.listSegments(meeting.id)).toHaveLength(0)
  })

  it('config de STT ausente vira lastError sem derrubar a gravação', async () => {
    const { recorder, transcribe } = build({
      loadSttConfig: async () => ({ ok: false, error: 'VOZ_STT_URL ausente', url: null }),
    })
    await recorder.start({})
    await sleep(40)
    expect(recorder.getState()).toMatchObject({ sttOk: false, lastError: 'VOZ_STT_URL ausente' })
    expect(transcribe).not.toHaveBeenCalled()
    expect((await recorder.stop()).status).toBe('done')
  })
})

describe('auto-stop', () => {
  it('para e notifica após autoStopMs sem áudio nas duas trilhas', async () => {
    const { recorder, notify } = build({
      env: fixtureEnv({ CM_MEETING_FIXTURE_SYSTEM: resolve(fixtures, 'silence-5s.wav'), CM_MEETING_FIXTURE_MIC: '' }),
      autoStopMs: 60,
      levelIntervalMs: 10,
    })
    const meeting = await recorder.start({})
    await sleep(250)
    expect(recorder.getState().active).toBeNull()
    expect(store.get(meeting.id)?.meeting.status).toBe('done')
    expect(notify).toHaveBeenCalledWith({ title: 'Gravação encerrada', body: '15 minutos sem áudio' })
  })
})

describe('modo de captura por trilha', () => {
  it('mic fixture + sistema real: them vai pro pipewire com o sink, me fica em fixture', async () => {
    const startCapture = vi.fn<RecorderDeps['startCapture']>(() => ({
      onData: () => {},
      onExit: () => {},
      stop: () => {},
    }))
    const mic = resolve(fixtures, 'mic-eu.wav')
    const { recorder } = build({
      startCapture,
      env: { CM_MEETING_FIXTURE_MIC: mic, CM_MEETING_FIXTURE_PACE: '0' },
    })

    await recorder.start({})
    expect(recorder.getState().captureMode).toBe('pipewire')

    const byTrack = Object.fromEntries(startCapture.mock.calls.map(([opts]) => [opts.track, opts]))
    expect(byTrack.them).toMatchObject({ mode: 'pipewire', target: 'sink.x', fixturePath: undefined })
    expect(byTrack.me).toMatchObject({ mode: 'fixture', target: 'source.x', fixturePath: mic })

    await recorder.stop()
  })
})

describe('appendQuickNote', () => {
  it('concatena com timestamp [mm:ss] e faz broadcast da reunião', async () => {
    let now = 1_000_000
    const { recorder, broadcast } = build({ now: () => now })
    const meeting = await recorder.start({})
    now += 65_000
    const first = recorder.appendQuickNote(meeting.id, '  decidimos X ')
    expect(first.rawNotes).toBe('- [01:05] decidimos X')
    now += 1_000
    const second = recorder.appendQuickNote(meeting.id, 'Y')
    expect(second.rawNotes).toBe('- [01:05] decidimos X\n- [01:06] Y')
    expect(recorder.appendQuickNote(meeting.id, '   ').rawNotes).toBe(second.rawNotes)
    expect(events(broadcast, 'meeting').at(-1)?.meeting).toMatchObject({ rawNotes: second.rawNotes })
    expect(() => recorder.appendQuickNote('nope', 'x')).toThrow(/não encontrada/)
    await recorder.stop()
  })
})

describe('checkSetup', () => {
  it('agrega pipewire, dispositivos e STT', async () => {
    const { recorder } = build()
    expect(await recorder.checkSetup()).toEqual({
      pipewire: true,
      sink: 'sink.x',
      source: 'source.x',
      stt: { ok: true, url: 'https://stt/v1', error: null },
    })
    const broken = build({
      hasPipewire: async () => false,
      resolveDefaultDevices: async () => ({ sink: null, source: null }),
      loadSttConfig: async () => ({ ok: false, error: 'sem key', url: 'https://stt/v1' }),
    })
    expect(await broken.recorder.checkSetup()).toEqual({
      pipewire: false,
      sink: null,
      source: null,
      stt: { ok: false, url: 'https://stt/v1', error: 'sem key' },
    })
  })
})

describe('vínculo com o detector', () => {
  it('start() copia o streamId da detecção corrente pra linkedStreamId e expõe a detecção no estado', async () => {
    const detection = { app: 'navegador (Google Chrome input)', binary: 'chrome', pid: 4242, streamId: 147, since: 1, ignored: false }
    detectorRegistry.current = { getDetection: () => detection, decide: () => {} }
    const { recorder } = build()
    expect(recorder.getState()).toMatchObject({ detection, linkedStreamId: null })
    await recorder.start({})
    expect(recorder.getState()).toMatchObject({ detection, linkedStreamId: 147 })
    await recorder.stop()
    expect(recorder.getState().linkedStreamId).toBeNull()
  })

  it('sem detector registrado, linkedStreamId e detection ficam null', async () => {
    const { recorder } = build()
    await recorder.start({})
    expect(recorder.getState()).toMatchObject({ detection: null, linkedStreamId: null })
    await recorder.stop()
  })
})
