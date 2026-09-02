import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Meeting, MeetingDetection, MeetingLiveState } from '../../../../shared/types/meetings'

const trayInstances: Array<Record<string, ReturnType<typeof vi.fn>>> = []
let trayCtorError: Error | null = null
const appQuit = vi.fn()
const buildFromTemplate = vi.fn((template: unknown) => ({ template }))

vi.mock('electron', () => ({
  app: { quit: () => appQuit() },
  Menu: { buildFromTemplate: (t: unknown) => buildFromTemplate(t) },
  Tray: class {
    setToolTip = vi.fn()
    setImage = vi.fn()
    setContextMenu = vi.fn()
    on = vi.fn()
    destroy = vi.fn()
    constructor(public image: unknown) {
      if (trayCtorError) throw trayCtorError
      trayInstances.push(this as unknown as Record<string, ReturnType<typeof vi.fn>>)
    }
  },
}))

vi.mock('./tray-icons', () => ({
  trayIcons: () => ({ idle: 'IDLE', recording: 'REC', recordingDim: 'DIM', detected: 'AMBER' }),
}))

const mainWindow = { show: vi.fn(), focus: vi.fn() }
vi.mock('../notifications', () => ({ getMainWindow: () => mainWindow }))
vi.mock('../notify', () => ({ broadcast: vi.fn() }))

import { emitMeetingEvent } from './event-bus'
import { detectorRegistry, floatingRegistry, recorderRegistry } from './recorder-contract'
import { formatClock, installTray, refreshTray, trayMenuTemplate, uninstallTray } from './tray'

const meeting: Meeting = {
  id: 'm1',
  title: 'Daily',
  status: 'recording',
  startedAt: 0,
  endedAt: null,
  rawNotes: '',
  summaryMd: null,
  themLabel: 'Participante',
  error: null,
  sttModel: null,
  summaryModel: null,
  createdAt: 0,
  updatedAt: 0,
  segmentCount: 0,
  durationMs: 0,
  speakers: [],
  lastError: null,
  respawns: 0,
  micLevelDbfs: null,
  diarization: null,
}

const idle: MeetingLiveState = {
  active: null,
  elapsedMs: 0,
  levels: { me: 0, them: 0 },
  sttOk: true,
  lastError: null,
  captureMode: 'pipewire',
  detection: null,
  linkedStreamId: null,
  micWarning: null,
  diarization: 'off',
}
const recording: MeetingLiveState = { ...idle, active: meeting, elapsedMs: 65_000 }
const detection: MeetingDetection = {
  app: 'Google Meet',
  binary: 'chrome',
  pid: 4242,
  streamId: 77,
  since: 0,
  ignored: false,
}
const detected: MeetingLiveState = { ...idle, detection }
const ignored: MeetingLiveState = { ...idle, detection: { ...detection, ignored: true } }
const recordingDetected: MeetingLiveState = { ...recording, detection }

const detector = {
  getDetection: vi.fn(() => detection),
  decide: vi.fn(),
}

const recorder = {
  start: vi.fn(async () => meeting),
  stop: vi.fn(async () => meeting),
  getState: vi.fn(() => idle),
  appendQuickNote: vi.fn(() => meeting),
  refreshState: vi.fn(),
}

function labels(template: unknown): string[] {
  return (template as Array<{ label?: string; type?: string }>).map((i) => i.label ?? i.type ?? '')
}

function lastTray() {
  return trayInstances[trayInstances.length - 1]
}

beforeEach(() => {
  vi.useFakeTimers()
  trayInstances.length = 0
  trayCtorError = null
  recorder.getState.mockReturnValue(idle)
  recorderRegistry.current = recorder
  detectorRegistry.current = detector
  floatingRegistry.current = vi.fn()
  vi.clearAllMocks()
})

afterEach(() => {
  uninstallTray()
  recorderRegistry.current = null
  detectorRegistry.current = null
  floatingRegistry.current = null
  vi.useRealTimers()
})

describe('formatClock', () => {
  it('formata mm:ss com zero à esquerda e passa de 59 min', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(65_000)).toBe('01:05')
    expect(formatClock(61 * 60_000)).toBe('61:00')
  })
})

describe('trayMenuTemplate', () => {
  it('ocioso: Iniciar gravação, sem Parar, com flutuante/abrir/sair', () => {
    expect(labels(trayMenuTemplate(idle))).toEqual([
      'Pitwall',
      'separator',
      'Iniciar gravação',
      'Mostrar/Ocultar janela flutuante',
      'separator',
      'Abrir Pitwall',
      'Sair',
    ])
  })

  it('gravando: linha de status desabilitada com o relógio + Parar gravação', () => {
    const template = trayMenuTemplate(recording)
    expect(template[0]).toEqual({ label: 'Pitwall', enabled: false })
    expect(labels(template)).toEqual([
      'Pitwall',
      'separator',
      '● Gravando 01:05',
      'Parar gravação',
      'Mostrar/Ocultar janela flutuante',
      'separator',
      'Abrir Pitwall',
      'Sair',
    ])
    expect(template[2].enabled).toBe(false)
  })

  it('ações: iniciar chama o gravador e mostra a flutuante; parar chama stop', async () => {
    const start = trayMenuTemplate(idle).find((i) => i.label === 'Iniciar gravação')!
    await (start.click as () => void)()
    await vi.runAllTimersAsync()
    expect(recorder.start).toHaveBeenCalledWith({})
    expect(floatingRegistry.current).toHaveBeenCalledWith('show')

    const stop = trayMenuTemplate(recording).find((i) => i.label === 'Parar gravação')!
    ;(stop.click as () => void)()
    expect(recorder.stop).toHaveBeenCalled()
  })

  it('detectada: Gravar/Ignorar no topo, Iniciar gravação continua disponível', () => {
    expect(labels(trayMenuTemplate(detected))).toEqual([
      'Pitwall',
      'separator',
      'Gravar reunião detectada (Google Meet)',
      'Ignorar esta reunião',
      'Iniciar gravação',
      'Mostrar/Ocultar janela flutuante',
      'separator',
      'Abrir Pitwall',
      'Sair',
    ])
  })

  it('detectada: Gravar chama decide(record), Ignorar chama decide(ignore)', () => {
    const template = trayMenuTemplate(detected)
    ;(template.find((i) => i.label === 'Gravar reunião detectada (Google Meet)')!.click as () => void)()
    expect(detector.decide).toHaveBeenCalledWith('record')
    ;(template.find((i) => i.label === 'Ignorar esta reunião')!.click as () => void)()
    expect(detector.decide).toHaveBeenCalledWith('ignore')
  })

  it('detectada sem detector registrado: clicar não crasha', () => {
    detectorRegistry.current = null
    const template = trayMenuTemplate(detected)
    expect(() => (template.find((i) => i.label === 'Ignorar esta reunião')!.click as () => void)()).not.toThrow()
  })

  it('ignorada ou já gravando: sem os itens de detecção', () => {
    expect(labels(trayMenuTemplate(ignored))[2]).toBe('Iniciar gravação')
    expect(labels(trayMenuTemplate(recordingDetected))[2]).toBe('● Gravando 01:05')
  })

  it('ações: flutuante toggle, abrir foca a principal, sair encerra o app', () => {
    const template = trayMenuTemplate(idle)
    ;(template.find((i) => i.label === 'Mostrar/Ocultar janela flutuante')!.click as () => void)()
    expect(floatingRegistry.current).toHaveBeenCalledWith('toggle')
    ;(template.find((i) => i.label === 'Abrir Pitwall')!.click as () => void)()
    expect(mainWindow.show).toHaveBeenCalled()
    expect(mainWindow.focus).toHaveBeenCalled()
    ;(template.find((i) => i.label === 'Sair')!.click as () => void)()
    expect(appQuit).toHaveBeenCalled()
  })
})

describe('installTray / refreshTray', () => {
  it('cria o tray ocioso com tooltip Pitwall e menu do estado atual do gravador', () => {
    installTray()
    const tray = lastTray()
    expect(tray.image).toBe('IDLE')
    expect(tray.setToolTip).toHaveBeenCalledWith('Pitwall')
    expect(tray.on).toHaveBeenCalledWith('click', expect.any(Function))
    expect(labels(buildFromTemplate.mock.calls.at(-1)![0])[2]).toBe('Iniciar gravação')
  })

  it('não crasha quando o Tray não pode ser criado', () => {
    trayCtorError = new Error('no SNI host')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => installTray()).not.toThrow()
    expect(warn).toHaveBeenCalledWith('[meetings] tray indisponível', trayCtorError)
    expect(() => refreshTray(recording)).not.toThrow()
    warn.mockRestore()
  })

  it('gravando: pisca a cada 700 ms, tooltip com relógio, menu acompanha o tempo', () => {
    installTray()
    const tray = lastTray()
    refreshTray(recording)
    expect(tray.setImage).toHaveBeenLastCalledWith('REC')
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Pitwall — gravando 01:05')
    expect(labels(buildFromTemplate.mock.calls.at(-1)![0])[2]).toBe('● Gravando 01:05')

    vi.advanceTimersByTime(700)
    expect(tray.setImage).toHaveBeenLastCalledWith('DIM')
    vi.advanceTimersByTime(700)
    expect(tray.setImage).toHaveBeenLastCalledWith('REC')
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Pitwall — gravando 01:06')
    expect(labels(buildFromTemplate.mock.calls.at(-1)![0])[2]).toBe('● Gravando 01:06')
  })

  it('ao parar volta pro ícone ocioso e para de piscar', () => {
    installTray()
    const tray = lastTray()
    refreshTray(recording)
    refreshTray(idle)
    expect(tray.setImage).toHaveBeenLastCalledWith('IDLE')
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Pitwall')
    tray.setImage.mockClear()
    vi.advanceTimersByTime(2100)
    expect(tray.setImage).not.toHaveBeenCalled()
  })

  it('detectada: ícone âmbar fixo (sem piscar), tooltip com o app', () => {
    installTray()
    const tray = lastTray()
    emitMeetingEvent({ type: 'state', state: detected })
    expect(tray.setImage).toHaveBeenLastCalledWith('AMBER')
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Pitwall — reunião detectada: Google Meet')
    expect(labels(buildFromTemplate.mock.calls.at(-1)![0]).slice(2, 4)).toEqual([
      'Gravar reunião detectada (Google Meet)',
      'Ignorar esta reunião',
    ])
    tray.setImage.mockClear()
    vi.advanceTimersByTime(2100)
    expect(tray.setImage).not.toHaveBeenCalled()
  })

  it('detecção ignorada: ícone ocioso e menu sem os itens de detecção', () => {
    installTray()
    const tray = lastTray()
    refreshTray(detected)
    refreshTray(ignored)
    expect(tray.setImage).toHaveBeenLastCalledWith('IDLE')
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Pitwall')
    expect(labels(buildFromTemplate.mock.calls.at(-1)![0])[2]).toBe('Iniciar gravação')
  })

  it('gravando com detecção presente: vermelho piscando, não âmbar', () => {
    installTray()
    const tray = lastTray()
    refreshTray(recordingDetected)
    expect(tray.setImage).toHaveBeenLastCalledWith('REC')
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Pitwall — gravando 01:05')
    vi.advanceTimersByTime(700)
    expect(tray.setImage).toHaveBeenLastCalledWith('DIM')
  })

  it('assina o event-bus: evento de estado atualiza o tray', () => {
    installTray()
    const tray = lastTray()
    emitMeetingEvent({ type: 'state', state: recording })
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Pitwall — gravando 01:05')
    emitMeetingEvent({ type: 'segment', segment: { id: 's', meetingId: 'm1', speaker: 'me', text: 'x', startMs: 0, endMs: 1, chunkIndex: 0, createdAt: 0, speakerId: null, speakerLabel: null } })
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Pitwall — gravando 01:05')
  })
})
