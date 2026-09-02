/** @vitest-environment node */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/meeting-detector-unused' },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}))

import { detectorRegistry } from './recorder-contract'
import {
  createDetector,
  DEFAULT_DENY_LIST,
  parseDump,
  parseScript,
  scriptDump,
  type Detector,
  type DetectorDeps,
} from './meeting-detector'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(__dirname, '__fixtures__', name), 'utf8'))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor: timeout')
    await sleep(5)
  }
}

interface FakeApp {
  clientId: number
  binary: string
  app?: string
  pid?: number
  nodes?: number[]
  state?: string
}

// Dump mínimo no shape real: Client separado do Node, join por client.id.
function dump(...apps: FakeApp[]): unknown[] {
  return apps.flatMap(({ clientId, binary, app, pid, nodes, state }) => [
    {
      id: clientId,
      type: 'PipeWire:Interface:Client',
      info: {
        props: {
          'application.name': app ?? binary,
          'application.process.binary': binary,
          'application.process.id': pid ?? clientId * 10,
        },
      },
    },
    ...(nodes ?? [clientId + 1]).map((id) => ({
      id,
      type: 'PipeWire:Interface:Node',
      info: { state: state ?? 'running', props: { 'media.class': 'Stream/Input/Audio', 'client.id': clientId } },
    })),
  ])
}

const chrome = (over: Partial<FakeApp> = {}): FakeApp => ({
  clientId: 200,
  binary: 'chrome',
  app: 'Google Chrome input',
  pid: 4242,
  ...over,
})

describe('parseDump', () => {
  it('fixture real do arecord: um stream aplay (client 104 → node 147); Chrome sem stream fica de fora', () => {
    expect(parseDump(fixture('pw-dump-arecord-real.json'))).toEqual([
      {
        clientId: 104,
        streamId: 147,
        binary: 'aplay',
        pid: 237602,
        app: 'PipeWire ALSA [aplay]',
        label: 'PipeWire ALSA [aplay]',
      },
    ])
  })

  it('fixture vazio e JSON que não é array → nada', () => {
    expect(parseDump(fixture('pw-dump-empty.json'))).toEqual([])
    expect(parseDump({ nope: true })).toEqual([])
  })

  it('deny-list corta o pw-cat do próprio Pitwall; suspended não conta', () => {
    expect(DEFAULT_DENY_LIST.has('pw-cat')).toBe(true)
    expect(DEFAULT_DENY_LIST.has('aplay')).toBe(false)
    expect(parseDump(dump({ clientId: 300, binary: 'pw-cat' }))).toEqual([])
    expect(parseDump(dump(chrome({ state: 'suspended' })))).toEqual([])
  })

  it('agrupa por client com o menor node id e rotula navegadores e apps conhecidos', () => {
    const streams = parseDump(dump(chrome({ nodes: [310, 305] }), { clientId: 400, binary: 'zoom', app: 'ZOOM VoiceEngine' }))
    expect(streams).toEqual([
      { clientId: 200, streamId: 305, binary: 'chrome', pid: 4242, app: 'Google Chrome input', label: 'navegador (Google Chrome input)' },
      { clientId: 400, streamId: 401, binary: 'zoom', pid: 4000, app: 'ZOOM VoiceEngine', label: 'Zoom' },
    ])
  })
})

describe('script sintético', () => {
  it('parseScript ordena a timeline e scriptDump devolve dump parseável', () => {
    const steps = parseScript('25:none, 2:chrome')
    expect(steps).toEqual([
      { atMs: 2000, binary: 'chrome' },
      { atMs: 25_000, binary: null },
    ])
    expect(parseDump(scriptDump(steps, 1000))).toEqual([])
    expect(parseDump(scriptDump(steps, 2000))).toMatchObject([{ binary: 'chrome', label: 'navegador (chrome)' }])
    expect(parseDump(scriptDump(steps, 30_000))).toEqual([])
    expect(() => parseScript('abc')).toThrow(/inválido/)
  })
})

const created: Detector[] = []
afterEach(() => {
  for (const d of created.splice(0)) d.stop()
  detectorRegistry.current = null
})

function build(over: Partial<DetectorDeps> = {}) {
  let current: unknown = []
  let failing = false
  const recorder: { active: { id: string } | null; linkedStreamId: number | null } = { active: null, linkedStreamId: null }
  const prefs: Record<string, unknown> = {}
  const notify = vi.fn<DetectorDeps['notify']>()
  const refreshState = vi.fn()
  const startRecording = vi.fn(async () => {
    recorder.active = { id: 'm1' }
    recorder.linkedStreamId = detectorRegistry.current?.getDetection()?.streamId ?? null
  })
  const stopRecording = vi.fn(async () => {
    recorder.active = null
    recorder.linkedStreamId = null
  })
  const exec = vi.fn<DetectorDeps['exec']>(async () => {
    if (failing) throw new Error('pw-dump: boom')
    return { stdout: JSON.stringify(current) }
  })
  const detector = createDetector({
    exec,
    pollMs: 10,
    detectMs: 30,
    endMs: 60,
    graceMs: 30,
    backoffMs: 40,
    getPref: <T>(key: string, fallback: T): T => (key in prefs ? (prefs[key] as T) : fallback),
    notify,
    refreshState,
    startRecording,
    stopRecording,
    getRecorderState: () => ({ active: recorder.active as never, linkedStreamId: recorder.linkedStreamId }),
    hasPipewire: async () => true,
    env: {},
    log: () => {},
    ...over,
  })
  created.push(detector)
  return {
    detector,
    set: (d: unknown) => {
      current = d
    },
    fail: (v: boolean) => {
      failing = v
    },
    recorder,
    prefs,
    notify,
    refreshState,
    startRecording,
    stopRecording,
    exec,
  }
}

const phase = (d: Detector) => d._state().phase

describe('máquina de estados', () => {
  it('chrome → pending → detected (1 notificação com onClick) → some → ending → ended → idle', async () => {
    const { detector, set, notify, refreshState } = build()
    set(dump(chrome()))
    detector.start()
    await waitFor(() => phase(detector) === 'pending')
    expect(detector.getDetection()).toBeNull()
    await waitFor(() => phase(detector) === 'detected')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({
      title: 'Reunião detectada',
      body: 'navegador (Google Chrome input) está usando o microfone. Clique para gravar.',
    })
    expect(notify.mock.calls[0][0].onClick).toBeTypeOf('function')
    expect(detector.getDetection()).toMatchObject({
      app: 'navegador (Google Chrome input)',
      binary: 'chrome',
      pid: 4242,
      streamId: 201,
      ignored: false,
    })
    expect(detectorRegistry.current?.getDetection()?.streamId).toBe(201)

    set([])
    await waitFor(() => phase(detector) === 'ending')
    expect(detector.getDetection()).not.toBeNull()
    await waitFor(() => phase(detector) === 'idle')
    expect(detector.getDetection()).toBeNull()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(refreshState.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('candidato que some antes de detectMs volta a idle sem notificar', async () => {
    const { detector, set, notify } = build()
    set(dump(chrome()))
    detector.start()
    await waitFor(() => phase(detector) === 'pending')
    set([])
    await waitFor(() => phase(detector) === 'idle')
    await sleep(50)
    expect(notify).not.toHaveBeenCalled()
  })

  it('flap em ending volta a detected sem re-notificar; streamId novo do mesmo client é absorvido', async () => {
    const { detector, set, notify } = build()
    set(dump(chrome()))
    detector.start()
    await waitFor(() => phase(detector) === 'detected')
    set([])
    await waitFor(() => phase(detector) === 'ending')
    set(dump(chrome({ nodes: [250] })))
    await waitFor(() => phase(detector) === 'detected')
    expect(detector.getDetection()?.streamId).toBe(250)
    await sleep(50)
    expect(phase(detector)).toBe('detected')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('segundo client só vira candidato depois do ended do primeiro', async () => {
    const { detector, set, notify } = build()
    set(dump(chrome()))
    detector.start()
    await waitFor(() => phase(detector) === 'detected')
    set(dump(chrome(), { clientId: 500, binary: 'zoom' }))
    await sleep(60)
    expect(detector._state().clientId).toBe(200)
    set(dump({ clientId: 500, binary: 'zoom' }))
    await waitFor(() => phase(detector) === 'idle')
    await waitFor(() => phase(detector) === 'detected' && detector._state().clientId === 500)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(detector.getDetection()?.app).toBe('Zoom')
  })
})

describe('decisões', () => {
  it('ignore marca ignored até ended; o próximo episódio nasce limpo', async () => {
    const { detector, set, refreshState } = build()
    set(dump(chrome()))
    detector.start()
    await waitFor(() => phase(detector) === 'detected')
    const before = refreshState.mock.calls.length
    detector.decide('ignore')
    expect(detector.getDetection()?.ignored).toBe(true)
    expect(refreshState.mock.calls.length).toBe(before + 1)
    set([])
    await waitFor(() => phase(detector) === 'idle')
    set(dump(chrome()))
    await waitFor(() => phase(detector) === 'detected')
    expect(detector.getDetection()?.ignored).toBe(false)
  })

  it('onClick da notificação grava; record com gravação ativa é ignorado', async () => {
    const { detector, set, notify, startRecording } = build()
    set(dump(chrome()))
    detector.start()
    await waitFor(() => phase(detector) === 'detected')
    notify.mock.calls[0][0].onClick?.()
    await waitFor(() => startRecording.mock.calls.length === 1)
    detector.decide('record')
    detectorRegistry.current?.decide('record')
    await sleep(20)
    expect(startRecording).toHaveBeenCalledTimes(1)
  })

  it('decide sem candidato é no-op', () => {
    const { detector, startRecording } = build()
    detector.decide('record')
    detector.decide('ignore')
    expect(startRecording).not.toHaveBeenCalled()
  })

  it('meeting_auto_record grava na hora e notifica "Gravando reunião detectada"', async () => {
    const { detector, set, prefs, notify, startRecording, recorder } = build()
    prefs.meeting_auto_record = true
    set(dump(chrome()))
    detector.start()
    await waitFor(() => phase(detector) === 'detected')
    await waitFor(() => recorder.active !== null)
    expect(startRecording).toHaveBeenCalledTimes(1)
    expect(recorder.linkedStreamId).toBe(201)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toEqual({
      title: 'Gravando reunião detectada',
      body: 'navegador (Google Chrome input) está usando o microfone.',
    })
  })

  it('já gravando quando detecta: não notifica nem tenta gravar de novo', async () => {
    const { detector, set, notify, startRecording, recorder } = build()
    recorder.active = { id: 'manual' }
    set(dump(chrome()))
    detector.start()
    await waitFor(() => phase(detector) === 'detected')
    expect(notify).not.toHaveBeenCalled()
    expect(startRecording).not.toHaveBeenCalled()
  })
})

describe('auto-stop vinculado', () => {
  it('gravação vinculada para após graceMs quando o stream acaba, com notificação', async () => {
    const { detector, set, notify, stopRecording, recorder } = build()
    set(dump(chrome()))
    detector.start()
    await waitFor(() => phase(detector) === 'detected')
    detector.decide('record')
    await waitFor(() => recorder.linkedStreamId === 201)
    set([])
    await waitFor(() => phase(detector) === 'idle')
    expect(stopRecording).not.toHaveBeenCalled()
    await waitFor(() => stopRecording.mock.calls.length === 1)
    await waitFor(() => notify.mock.calls.length === 2)
    expect(notify.mock.calls[1][0]).toEqual({ title: 'Gravação encerrada', body: 'A chamada terminou.' })
  })

  it('stream reaparece durante a graça: não para', async () => {
    const { detector, set, stopRecording, recorder } = build()
    set(dump(chrome()))
    detector.start()
    await waitFor(() => phase(detector) === 'detected')
    detector.decide('record')
    await waitFor(() => recorder.linkedStreamId === 201)
    set([])
    await waitFor(() => phase(detector) === 'idle')
    set(dump(chrome()))
    await sleep(80)
    expect(stopRecording).not.toHaveBeenCalled()
    expect(recorder.active).not.toBeNull()
  })

  it('gravação sem vínculo (presencial) não é parada pelo detector', async () => {
    const { detector, set, stopRecording, recorder } = build()
    recorder.active = { id: 'manual' }
    recorder.linkedStreamId = null
    set(dump(chrome()))
    detector.start()
    await waitFor(() => phase(detector) === 'detected')
    set([])
    await waitFor(() => phase(detector) === 'idle')
    await sleep(80)
    expect(stopRecording).not.toHaveBeenCalled()
  })

  it('parar manualmente a gravação vinculada marca a detecção como ignorada', async () => {
    const { detector, set, recorder } = build()
    set(dump(chrome()))
    detector.start()
    await waitFor(() => phase(detector) === 'detected')
    detector.decide('record')
    await waitFor(() => recorder.linkedStreamId === 201)
    await sleep(20)
    recorder.active = null
    recorder.linkedStreamId = null
    await waitFor(() => detector.getDetection()?.ignored === true)
    expect(phase(detector)).toBe('detected')
  })
})

describe('resiliência', () => {
  it('pw-dump falhando congela o estado; 3 falhas entram em backoff e uma só linha de log', async () => {
    const log = vi.fn()
    const { detector, set, fail, exec, stopRecording } = build({ log })
    set(dump(chrome()))
    detector.start()
    await waitFor(() => phase(detector) === 'detected')
    fail(true)
    await waitFor(() => detector._state().failures >= 3)
    const callsAtBackoff = exec.mock.calls.length
    await sleep(25)
    expect(exec.mock.calls.length).toBe(callsAtBackoff)
    expect(phase(detector)).toBe('detected')
    expect(detector.getDetection()).not.toBeNull()
    await waitFor(() => exec.mock.calls.length > callsAtBackoff, 200)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toMatch(/pw-dump falhou 3x/)
    fail(false)
    await waitFor(() => detector._state().failures === 0)
    expect(phase(detector)).toBe('detected')
    expect(stopRecording).not.toHaveBeenCalled()
  })

  it('pref meeting_auto_detect=false ou sem PipeWire: não faz poll', async () => {
    const off = build()
    off.prefs.meeting_auto_detect = false
    off.detector.start()
    const noPw = build({ hasPipewire: async () => false })
    noPw.detector.start()
    await sleep(40)
    expect(off.exec).not.toHaveBeenCalled()
    expect(noPw.exec).not.toHaveBeenCalled()
  })

  it('stop() limpa o candidato e reemite estado', async () => {
    const { detector, set, refreshState } = build()
    set(dump(chrome()))
    detector.start()
    await waitFor(() => phase(detector) === 'detected')
    const before = refreshState.mock.calls.length
    detector.stop()
    expect(detector.getDetection()).toBeNull()
    expect(refreshState.mock.calls.length).toBe(before + 1)
  })
})

describe('CM_MEETING_DETECT_SCRIPT', () => {
  it('dirige o detector sem pw-dump, pelo mesmo parser', async () => {
    const { detector, exec, notify } = build({ env: { CM_MEETING_DETECT_SCRIPT: '0:chrome,0.15:none' } })
    detector.start()
    await waitFor(() => phase(detector) === 'detected')
    expect(detector.getDetection()).toMatchObject({ binary: 'chrome', app: 'navegador (chrome)' })
    expect(notify).toHaveBeenCalledTimes(1)
    await waitFor(() => phase(detector) === 'ending')
    await waitFor(() => phase(detector) === 'idle')
    expect(exec).not.toHaveBeenCalled()
  })
})
