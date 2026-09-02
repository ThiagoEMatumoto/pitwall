// Janela flutuante always-on-top com notas ao vivo. Criada sob demanda, fechar
// = esconder (só o quit destrói), bounds lembrados em app_prefs.
import { app, BrowserWindow, type Rectangle } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MeetingEvent, MeetingFloatingAction } from '../../../../shared/types/meetings'
import { getPref, setPref } from '../prefs-store'
import { onMeetingEvent } from './event-bus'
import { floatingRegistry } from './recorder-contract'

export const FLOATING_BOUNDS_PREF_KEY = 'meeting_floating_bounds'
export const FLOATING_HIDE_DELAY_MS = 1500
const BOUNDS_SAVE_DEBOUNCE_MS = 400

const __dirname = dirname(fileURLToPath(import.meta.url))

let win: BrowserWindow | null = null
let allowClose = false
let hideTimer: ReturnType<typeof setTimeout> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let wasActive = false
let unsubscribe: (() => void) | null = null

function savedBounds(): Partial<Rectangle> {
  try {
    const b = getPref<Partial<Rectangle> | null>(FLOATING_BOUNDS_PREF_KEY, null)
    if (!b) return {}
    const keys = ['x', 'y', 'width', 'height'] as const
    const valid = keys.every((k) => b[k] === undefined || Number.isFinite(b[k]))
    return valid ? b : {}
  } catch {
    return {}
  }
}

function scheduleSaveBounds(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!win || win.isDestroyed()) return
    try {
      setPref(FLOATING_BOUNDS_PREF_KEY, win.getBounds())
    } catch (err) {
      console.warn('[meetings] falha ao salvar bounds da flutuante', err)
    }
  }, BOUNDS_SAVE_DEBOUNCE_MS)
}

function loadContent(w: BrowserWindow): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) {
    void w.loadURL(`${devUrl.replace(/\/$/, '')}/floating.html`)
  } else {
    void w.loadFile(join(__dirname, '../renderer/floating.html'))
  }
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 380,
    height: 520,
    ...savedBounds(),
    minWidth: 300,
    minHeight: 240,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    type: 'toolbar',
    skipTaskbar: true,
    resizable: true,
    show: false,
    backgroundColor: '#08080b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  w.setAlwaysOnTop(true, 'screen-saver')
  w.on('close', (event) => {
    if (allowClose) return
    event.preventDefault()
    w.hide()
  })
  w.on('move', scheduleSaveBounds)
  w.on('resize', scheduleSaveBounds)
  w.on('closed', () => {
    if (win === w) win = null
  })
  loadContent(w)
  return w
}

function getWindow(): BrowserWindow {
  if (!win || win.isDestroyed()) win = createWindow()
  return win
}

function clearHideTimer(): void {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
}

export function controlFloatingWindow(action: MeetingFloatingAction): void {
  clearHideTimer()
  switch (action) {
    case 'show':
      getWindow().show()
      return
    case 'hide':
      if (win && !win.isDestroyed()) win.hide()
      return
    case 'toggle':
      if (win && !win.isDestroyed() && win.isVisible()) win.hide()
      else getWindow().show()
      return
  }
}

export function floatingOnMeetingEvent(event: MeetingEvent): void {
  if (event.type !== 'state') return
  const active = event.state.active !== null
  if (active && !wasActive) {
    controlFloatingWindow('show')
  } else if (!active && wasActive) {
    clearHideTimer()
    hideTimer = setTimeout(() => {
      hideTimer = null
      controlFloatingWindow('hide')
    }, FLOATING_HIDE_DELAY_MS)
  }
  wasActive = active
}

export function installFloatingWindow(): void {
  allowClose = false
  wasActive = false
  floatingRegistry.current = controlFloatingWindow
  unsubscribe?.()
  unsubscribe = onMeetingEvent(floatingOnMeetingEvent)
  // O close da flutuante só esconde; no quit precisa deixar fechar de verdade,
  // senão o preventDefault cancela o app.quit().
  app.once('before-quit', () => {
    allowClose = true
  })
}

export function uninstallFloatingWindow(): void {
  allowClose = true
  clearHideTimer()
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  unsubscribe?.()
  unsubscribe = null
  wasActive = false
  if (floatingRegistry.current === controlFloatingWindow) floatingRegistry.current = null
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}
