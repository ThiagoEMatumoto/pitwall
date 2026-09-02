// Ícone na barra do sistema: menu por estado + pisca durante gravação. Sem SNI
// host (GNOME sem appindicator) o Tray falha — loga e segue; janela principal e
// flutuante continuam mostrando o estado.
import { app, Menu, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import type { MeetingEvent, MeetingLiveState } from '../../../../shared/types/meetings'
import { getMainWindow } from '../notifications'
import { onMeetingEvent } from './event-bus'
import { floatingRegistry, recorderRegistry } from './recorder-contract'
import { startRecording, stopRecording } from './recording-actions'
import { trayIcons, type TrayIconKind } from './tray-icons'

export const TRAY_BLINK_MS = 700

let tray: Tray | null = null
let icons: Record<TrayIconKind, NativeImage> | null = null
let blinkTimer: ReturnType<typeof setInterval> | null = null
let blinkOn = true
// Âncora de relógio: o estado chega com elapsedMs; entre eventos o tick do
// pisca deriva mm:ss daqui pra não depender da frequência do broadcast.
let recordingAnchor: number | null = null
let menuClock = ''
let unsubscribe: (() => void) | null = null

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function warn(err: unknown): void {
  console.warn('[meetings] ação do tray falhou:', err)
}

function showMainWindow(): void {
  const win = getMainWindow()
  if (!win) return
  win.show()
  win.focus()
}

export function trayMenuTemplate(
  state: MeetingLiveState,
  clock = formatClock(state.elapsedMs),
): MenuItemConstructorOptions[] {
  const active = state.active !== null
  const recordingItems: MenuItemConstructorOptions[] = active
    ? [
        { label: `● Gravando ${clock}`, enabled: false },
        { label: 'Parar gravação', click: () => void stopRecording().catch(warn) },
      ]
    : [{ label: 'Iniciar gravação', click: () => void startRecording().catch(warn) }]

  return [
    ...recordingItems,
    {
      label: 'Mostrar/Ocultar janela flutuante',
      click: () => floatingRegistry.current?.('toggle'),
    },
    { type: 'separator' },
    { label: 'Abrir Pitwall', click: showMainWindow },
    { label: 'Sair', click: () => app.quit() },
  ]
}

function applyMenu(state: MeetingLiveState, clock: string): void {
  if (!tray) return
  menuClock = clock
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(state, clock)))
}

function stopBlink(): void {
  if (blinkTimer) clearInterval(blinkTimer)
  blinkTimer = null
  blinkOn = true
  recordingAnchor = null
}

function blinkTick(state: MeetingLiveState): void {
  if (!tray || !icons || recordingAnchor === null) return
  blinkOn = !blinkOn
  tray.setImage(blinkOn ? icons.recording : icons.recordingDim)
  const clock = formatClock(Date.now() - recordingAnchor)
  tray.setToolTip(`Pitwall — gravando ${clock}`)
  if (clock !== menuClock) applyMenu(state, clock)
}

export function refreshTray(state: MeetingLiveState): void {
  if (!tray || !icons) return
  const clock = formatClock(state.elapsedMs)
  applyMenu(state, clock)

  if (state.active) {
    recordingAnchor = Date.now() - state.elapsedMs
    tray.setImage(blinkOn ? icons.recording : icons.recordingDim)
    tray.setToolTip(`Pitwall — gravando ${clock}`)
    if (!blinkTimer) blinkTimer = setInterval(() => blinkTick(state), TRAY_BLINK_MS)
    return
  }

  stopBlink()
  tray.setImage(icons.idle)
  tray.setToolTip('Pitwall')
}

export function trayOnMeetingEvent(event: MeetingEvent): void {
  if (event.type === 'state') refreshTray(event.state)
}

const IDLE_STATE: MeetingLiveState = {
  active: null,
  elapsedMs: 0,
  levels: { me: 0, them: 0 },
  sttOk: false,
  lastError: null,
  captureMode: 'pipewire',
}

function currentState(): MeetingLiveState {
  try {
    return recorderRegistry.current?.getState() ?? IDLE_STATE
  } catch {
    return IDLE_STATE
  }
}

export function installTray(): void {
  if (tray) return
  try {
    icons = trayIcons()
    tray = new Tray(icons.idle)
    tray.setToolTip('Pitwall')
    tray.on('click', showMainWindow)
    refreshTray(currentState())
    unsubscribe = onMeetingEvent(trayOnMeetingEvent)
  } catch (err) {
    console.warn('[meetings] tray indisponível', err)
    tray = null
    icons = null
  }
}

export function uninstallTray(): void {
  stopBlink()
  unsubscribe?.()
  unsubscribe = null
  menuClock = ''
  try {
    tray?.destroy()
  } catch (err) {
    console.warn('[meetings] falha ao destruir tray', err)
  }
  tray = null
  icons = null
}
