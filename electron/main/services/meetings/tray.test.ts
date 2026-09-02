import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Meeting, MeetingLiveState } from '../../../../shared/types/meetings'

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
  trayIcons: () => ({ idle: 'IDLE', recording: 'REC', recordingDim: 'DIM' }),
}))

const mainWindow = { show: vi.fn(), focus: vi.fn() }
vi.mock('../notifications', () => ({ getMainWindow: () => mainWindow }))
vi.mock('../notify', () => ({ broadcast: vi.fn() }))

import { emitMeetingEvent } from './event-bus'
import { floatingRegistry, recorderRegistry } from './recorder-contract'
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
}

const idle: MeetingLiveState = {
  active: null,
  elapsedMs: 0,
  levels: { me: 0, them: 0 },
  sttOk: true,
  lastError: null,
  captureMode: 'pipewire',
}
const recording: MeetingLiveState = { ...idle, active: meeting, elapsedMs: 65_000 }

const recorder = {
  start: vi.fn(async () => meeting),
  stop: vi.fn(async () => meeting),
  getState: vi.fn(() => idle),
  appendQuickNote: vi.fn(() => meeting),
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
  floatingRegistry.current = vi.fn()
  vi.clearAllMocks()
})

afterEach(() => {
  uninstallTray()
  recorderRegistry.current = null
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
      'Iniciar gravação',
      'Mostrar/Ocultar janela flutuante',
      'separator',
      'Abrir Pitwall',
      'Sair',
    ])
  })

  it('gravando: linha de status desabilitada com o relógio + Parar gravação', () => {
    const template = trayMenuTemplate(recording)
    expect(labels(template)).toEqual([
      '● Gravando 01:05',
      'Parar gravação',
      'Mostrar/Ocultar janela flutuante',
      'separator',
      'Abrir Pitwall',
      'Sair',
    ])
    expect(template[0].enabled).toBe(false)
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
    expect(labels(buildFromTemplate.mock.calls.at(-1)![0])[0]).toBe('Iniciar gravação')
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
    expect(labels(buildFromTemplate.mock.calls.at(-1)![0])[0]).toBe('● Gravando 01:05')

    vi.advanceTimersByTime(700)
    expect(tray.setImage).toHaveBeenLastCalledWith('DIM')
    vi.advanceTimersByTime(700)
    expect(tray.setImage).toHaveBeenLastCalledWith('REC')
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Pitwall — gravando 01:06')
    expect(labels(buildFromTemplate.mock.calls.at(-1)![0])[0]).toBe('● Gravando 01:06')
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

  it('assina o event-bus: evento de estado atualiza o tray', () => {
    installTray()
    const tray = lastTray()
    emitMeetingEvent({ type: 'state', state: recording })
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Pitwall — gravando 01:05')
    emitMeetingEvent({ type: 'segment', segment: { id: 's', meetingId: 'm1', speaker: 'me', text: 'x', startMs: 0, endMs: 1, chunkIndex: 0, createdAt: 0 } })
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Pitwall — gravando 01:05')
  })
})
