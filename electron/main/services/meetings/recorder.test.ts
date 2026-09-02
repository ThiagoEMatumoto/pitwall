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
import { startCapture as realStartCapture, type CaptureHandle } from './audio-capture'
import { peakDbfs } from './pcm-chunker'
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
    resolveSourceForStream: async () => null,
    measureMicLevel: async () => null,
    hasPipewire: async () => true,
    env: fixtureEnv(),
    levelIntervalMs: 20,
    ...over,
  })
  return { recorder, broadcast, notify, transcribe }
}

// Captura real em fixture, mas atenua o mic em memória (`gainDb` negativo)
// durante os primeiros `forMs` (Infinity = a trilha inteira). É como o headset
// com ganho de hardware em 0%: fala a −48 dBFS no lugar de −18.
function attenuatedMic(gainDb: number, forMs = Infinity): RecorderDeps['startCapture'] {
  const gain = Math.pow(10, gainDb / 20)
  return (opts) => {
    const handle = realStartCapture(opts)
    if (opts.track !== 'me') return handle
    let seen = 0
    const wrapped: CaptureHandle = {
      ...handle,
      onData: (cb) =>
        handle.onData((pcm) => {
          const elapsedMs = (seen / (16000 * 2)) * 1000
          seen += pcm.length
          if (elapsedMs >= forMs) return cb(pcm)
          const out = Buffer.alloc(pcm.length)
          for (let i = 0; i < pcm.length; i += 2) out.writeInt16LE(Math.round(pcm.readInt16LE(i) * gain), i)
          cb(out)
        }),
    }
    return wrapped
  }
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
      stderr: () => '',
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
      micLevel: { dbfs: null, source: 'source.x', low: false },
      diarization: { supported: false, addon: false, models: { segmentation: 'missing', embedding: 'missing', progress: null } },
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
      micLevel: { dbfs: null, source: null, low: false },
      diarization: { supported: false, addon: false, models: { segmentation: 'missing', embedding: 'missing', progress: null } },
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

describe('nível do microfone', () => {
  it('mic a −48 dBFS: micWarning + micLevelDbfs persistido, e o chunk ainda é transcrito (normalizado)', async () => {
    // mic-eu.wav começa com 2 s de silêncio: a sonda espera fala, não relógio
    const { recorder, broadcast, transcribe } = build({ startCapture: attenuatedMic(-30) })
    const meeting = await recorder.start({})
    await sleep(60)

    const warning = recorder.getState().micWarning
    expect(warning).not.toBeNull()
    expect(warning?.dbfs).toBeLessThan(-40)
    expect(warning?.dbfs).toBeGreaterThan(-60)
    expect(warning?.source).toBe('fixture')
    expect(store.get(meeting.id)?.meeting.micLevelDbfs).toBe(warning?.dbfs)
    expect(events(broadcast, 'state').some((e) => (e.state as { micWarning: unknown }).micWarning)).toBe(true)

    await recorder.stop()
    const me = store.listSegments(meeting.id).filter((seg) => seg.speaker === 'me')
    expect(me.length).toBeGreaterThanOrEqual(1)
    // o que foi pro STT já está normalizado a ~−3 dBFS de pico (nunca acima)
    for (const [input] of transcribe.mock.calls) {
      const peak = peakDbfs(input.wav.subarray(44))
      expect(peak).toBeGreaterThan(-4)
      expect(peak).toBeLessThanOrEqual(0)
    }
  })

  it('mic normal não avisa; aviso some quando um chunk chega com p95 acima de −40', async () => {
    const normal = build()
    const m1 = await normal.recorder.start({})
    await sleep(30)
    expect(normal.recorder.getState().micWarning).toBeNull()
    expect(store.get(m1.id)?.meeting.micLevelDbfs).toBeGreaterThan(-40)
    await normal.recorder.stop()

    // só os 6 primeiros segundos baixos: a sonda (2 s de fala) avisa, o 1º chunk (12 s) limpa
    const recovering = build({ startCapture: attenuatedMic(-30, 6000) })
    await recovering.recorder.start({})
    await sleep(30)
    const warnings = events(recovering.broadcast, 'state').map(
      (e) => (e.state as { micWarning: unknown }).micWarning,
    )
    expect(warnings.some(Boolean)).toBe(true)
    expect(recovering.recorder.getState().micWarning).toBeNull()
    await recovering.recorder.stop()
  })

  it('checkSetup mede o source default e marca low abaixo de −40 (não mede em fixture)', async () => {
    const measure = vi.fn(async () => -48)
    const real = build({ measureMicLevel: measure, env: { CM_MEETING_FIXTURE_PACE: '0' } })
    expect((await real.recorder.checkSetup()).micLevel).toEqual({ dbfs: -48, source: 'source.x', low: true })
    expect(measure).toHaveBeenCalledWith('source.x')

    measure.mockResolvedValueOnce(-20)
    expect((await real.recorder.checkSetup()).micLevel).toEqual({ dbfs: -20, source: 'source.x', low: false })

    const fixture = build({ measureMicLevel: measure })
    measure.mockClear()
    expect((await fixture.recorder.checkSetup()).micLevel).toEqual({ dbfs: null, source: 'source.x', low: false })
    expect(measure).not.toHaveBeenCalled()
  })
})

describe('source do stream detectado', () => {
  function captureMock() {
    return vi.fn<RecorderDeps['startCapture']>(() => ({
      onData: () => {},
      onExit: () => {},
      stop: () => {},
      stderr: () => '',
    }))
  }
  const detection = { app: 'chrome', binary: 'chrome', pid: 1, streamId: 147, since: 1, ignored: false }

  it('me usa a source do Link do stream quando há detecção; default quando o resolve falha', async () => {
    detectorRegistry.current = { getDetection: () => detection, decide: () => {} }
    const startCapture = captureMock()
    const resolveSourceForStream = vi.fn(async () => 'alsa_input.headset')
    const { recorder } = build({ startCapture, resolveSourceForStream, env: { CM_MEETING_FIXTURE_PACE: '0' } })
    await recorder.start({})
    expect(resolveSourceForStream).toHaveBeenCalledWith(147)
    const me = startCapture.mock.calls.map(([o]) => o).find((o) => o.track === 'me')
    expect(me?.target).toBe('alsa_input.headset')
    await recorder.stop()

    const fallback = captureMock()
    const r2 = build({ startCapture: fallback, resolveSourceForStream: async () => null, env: { CM_MEETING_FIXTURE_PACE: '0' } })
    await r2.recorder.start({})
    expect(fallback.mock.calls.map(([o]) => o).find((o) => o.track === 'me')?.target).toBe('source.x')
    await r2.recorder.stop()
  })

  it('sem detecção não consulta o pw-dump', async () => {
    const resolveSourceForStream = vi.fn(async () => 'x')
    const { recorder } = build({ startCapture: captureMock(), resolveSourceForStream, env: { CM_MEETING_FIXTURE_PACE: '0' } })
    await recorder.start({})
    expect(resolveSourceForStream).not.toHaveBeenCalled()
    await recorder.stop()
  })
})

describe('respawn do pw-record', () => {
  it('1º exit respawna e persiste respawns/lastError; 2º exit encerra com status error', async () => {
    const exits: Array<(code: number | null, stderr: string) => void> = []
    const startCapture = vi.fn<RecorderDeps['startCapture']>((opts) => ({
      onData: () => {},
      onExit: (cb) => {
        if (opts.track === 'me') exits.push(cb)
      },
      stop: () => {},
      stderr: () => '',
    }))
    const { recorder } = build({ startCapture, env: { CM_MEETING_FIXTURE_PACE: '0' } })
    const meeting = await recorder.start({})
    expect(exits).toHaveLength(1)

    exits[0](1, 'device busy')
    await sleep(10)
    expect(exits).toHaveLength(2)
    expect(recorder.getState().active?.status).toBe('recording')
    const after = store.get(meeting.id)?.meeting
    expect(after?.respawns).toBe(1)
    expect(after?.lastError).toMatch(/pw-record \(me\) saiu com código 1: device busy/)

    exits[1](1, 'device gone')
    await sleep(60)
    expect(recorder.getState().active).toBeNull()
    const final = store.get(meeting.id)?.meeting
    expect(final?.status).toBe('error')
    expect(final?.respawns).toBe(1)
    expect(final?.lastError).toMatch(/device gone/)
  })

  it('erro de STT vai pro lastError persistido', async () => {
    const failing = vi.fn(async () => {
      throw new SttError('HTTP 500', 500)
    })
    const { recorder } = build({ transcribeChunk: failing as unknown as RecorderDeps['transcribeChunk'] })
    const meeting = await recorder.start({})
    await sleep(40)
    expect(store.get(meeting.id)?.meeting.lastError).toMatch(/HTTP 500/)
    await recorder.stop()
  })
})

describe('sonda do mic com silêncio prolongado', () => {
  it('mic mudo de vez: avisa −100 dBFS depois do teto de 10 s mesmo sem janela ativa', async () => {
    const startCapture = vi.fn<RecorderDeps['startCapture']>((opts) => {
      let onData: (pcm: Buffer) => void = () => {}
      if (opts.track === 'me') {
        setImmediate(() => {
          for (let i = 0; i < 101; i++) onData(Buffer.alloc(3200)) // 10,1 s de silêncio em blocos de 100 ms
        })
      }
      return { onData: (cb) => (onData = cb), onExit: () => {}, stop: () => {}, stderr: () => '' }
    })
    const { recorder } = build({ startCapture, env: { CM_MEETING_FIXTURE_PACE: '0' } })
    const meeting = await recorder.start({})
    await sleep(20)
    expect(recorder.getState().micWarning).toEqual({ dbfs: -100, source: 'source.x' })
    expect(store.get(meeting.id)?.meeting.micLevelDbfs).toBe(-100)
    await recorder.stop()
  })
})
