import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Meeting, MeetingLiveState } from '../../../../shared/types/meetings'

type Handler = (...args: unknown[]) => void

const { FakeWindow, electronApp, appOnce, prefs } = vi.hoisted(() => {
  class FakeWindow {
    static instances: FakeWindow[] = []
    handlers = new Map<string, Handler[]>()
    visible = false
    destroyed = false
    bounds = { x: 10, y: 20, width: 380, height: 520 }
    show = vi.fn(() => {
      this.visible = true
    })
    hide = vi.fn(() => {
      this.visible = false
    })
    isVisible = () => this.visible
    isDestroyed = () => this.destroyed
    destroy = vi.fn(() => {
      this.destroyed = true
    })
    getBounds = () => this.bounds
    setVisibleOnAllWorkspaces = vi.fn()
    setAlwaysOnTop = vi.fn()
    loadURL = vi.fn(async () => {})
    loadFile = vi.fn(async () => {})
    on = vi.fn((event: string, handler: Handler) => {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
      return this
    })
    emit(event: string, ...args: unknown[]) {
      for (const h of this.handlers.get(event) ?? []) h(...args)
    }
    constructor(public options: Record<string, unknown>) {
      FakeWindow.instances.push(this)
    }
  }
  const appOnce = vi.fn()
  const electronApp = { isPackaged: true, once: (...args: unknown[]) => appOnce(...args) }
  const prefs = new Map<string, unknown>()
  return { FakeWindow, electronApp, appOnce, prefs }
})

vi.mock('electron', () => ({ app: electronApp, BrowserWindow: FakeWindow }))

vi.mock('../prefs-store', () => ({
  getPref: (key: string, fallback: unknown) => (prefs.has(key) ? prefs.get(key) : fallback),
  setPref: (key: string, value: unknown) => prefs.set(key, value),
}))
vi.mock('../notify', () => ({ broadcast: vi.fn() }))

import { emitMeetingEvent } from './event-bus'
import {
  FLOATING_BOUNDS_PREF_KEY,
  FLOATING_HIDE_DELAY_MS,
  controlFloatingWindow,
  installFloatingWindow,
  uninstallFloatingWindow,
} from './floating-window'
import { floatingRegistry } from './recorder-contract'

const meeting = { id: 'm1', rawNotes: '', themLabel: 'Participante' } as Meeting
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
const recording: MeetingLiveState = { ...idle, active: meeting, elapsedMs: 1000 }

beforeEach(() => {
  vi.useFakeTimers()
  FakeWindow.instances.length = 0
  prefs.clear()
  appOnce.mockClear()
  delete process.env.ELECTRON_RENDERER_URL
  electronApp.isPackaged = true
  installFloatingWindow()
})

afterEach(() => {
  uninstallFloatingWindow()
  vi.useRealTimers()
})

describe('installFloatingWindow', () => {
  it('registra o controle no registry sem criar a janela ainda', () => {
    expect(floatingRegistry.current).toBeTypeOf('function')
    expect(FakeWindow.instances).toHaveLength(0)
    expect(appOnce).toHaveBeenCalledWith('before-quit', expect.any(Function))
  })

  it('show cria a janela com as opções do design e carrega floating.html do build', () => {
    controlFloatingWindow('show')
    expect(FakeWindow.instances).toHaveLength(1)
    const win = FakeWindow.instances[0]
    expect(win.options).toMatchObject({
      width: 380,
      height: 520,
      minWidth: 300,
      minHeight: 240,
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      show: false,
      backgroundColor: '#08080b',
      webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false },
    })
    expect((win.options.webPreferences as { preload: string }).preload).toMatch(
      /preload[\\/]index\.mjs$/,
    )
    // type:'toolbar' vira _NET_WM_WINDOW_TYPE_TOOLBAR no X11 e o mutter recusa
    // mover/redimensionar a janela — a flutuante ficava presa no lugar.
    expect(win.options).not.toHaveProperty('type')
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true })
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver')
    expect(win.loadFile).toHaveBeenCalledWith(expect.stringMatching(/renderer[\\/]floating\.html$/))
    expect(win.show).toHaveBeenCalled()
  })

  it('em dev carrega floating.html da URL do renderer', () => {
    electronApp.isPackaged = false
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
    controlFloatingWindow('show')
    expect(FakeWindow.instances[0].loadURL).toHaveBeenCalledWith('http://localhost:5173/floating.html')
  })

  it('reusa a janela: hide e toggle agem sobre a mesma instância; hide sem janela é no-op', () => {
    floatingRegistry.current!('hide')
    expect(FakeWindow.instances).toHaveLength(0)

    floatingRegistry.current!('toggle')
    const win = FakeWindow.instances[0]
    expect(win.show).toHaveBeenCalledTimes(1)
    floatingRegistry.current!('toggle')
    expect(win.hide).toHaveBeenCalledTimes(1)
    floatingRegistry.current!('show')
    expect(win.show).toHaveBeenCalledTimes(2)
    expect(FakeWindow.instances).toHaveLength(1)
  })

  it('fechar só esconde (preventDefault) e bounds são lembrados na pref', () => {
    controlFloatingWindow('show')
    const win = FakeWindow.instances[0]
    const event = { preventDefault: vi.fn() }
    win.emit('close', event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(win.hide).toHaveBeenCalled()

    win.bounds = { x: 100, y: 200, width: 400, height: 300 }
    win.emit('move')
    win.emit('resize')
    vi.advanceTimersByTime(500)
    expect(prefs.get(FLOATING_BOUNDS_PREF_KEY)).toEqual(win.bounds)
  })

  it('aplica bounds salvos ao criar', () => {
    prefs.set(FLOATING_BOUNDS_PREF_KEY, { x: 5, y: 6, width: 333, height: 444 })
    controlFloatingWindow('show')
    expect(FakeWindow.instances[0].options).toMatchObject({ x: 5, y: 6, width: 333, height: 444 })
  })

  it('ignora bounds inválidos na pref', () => {
    prefs.set(FLOATING_BOUNDS_PREF_KEY, { x: 'nope', width: 333 })
    controlFloatingWindow('show')
    expect(FakeWindow.instances[0].options).toMatchObject({ width: 380, height: 520 })
  })
})

describe('auto show/hide por evento de estado', () => {
  it('mostra ao começar a gravar e esconde 1500 ms depois de parar', () => {
    emitMeetingEvent({ type: 'state', state: recording })
    const win = FakeWindow.instances[0]
    expect(win.show).toHaveBeenCalledTimes(1)

    emitMeetingEvent({ type: 'state', state: { ...recording, elapsedMs: 2000 } })
    expect(win.show).toHaveBeenCalledTimes(1)

    emitMeetingEvent({ type: 'state', state: idle })
    expect(win.hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(FLOATING_HIDE_DELAY_MS)
    expect(win.hide).toHaveBeenCalledTimes(1)
  })

  it('uma nova gravação dentro da janela de 1500 ms cancela o hide', () => {
    emitMeetingEvent({ type: 'state', state: recording })
    emitMeetingEvent({ type: 'state', state: idle })
    vi.advanceTimersByTime(500)
    emitMeetingEvent({ type: 'state', state: recording })
    vi.advanceTimersByTime(2000)
    expect(FakeWindow.instances[0].hide).not.toHaveBeenCalled()
  })

  it('estado ocioso sem gravação anterior não cria a janela', () => {
    emitMeetingEvent({ type: 'state', state: idle })
    expect(FakeWindow.instances).toHaveLength(0)
  })
})
