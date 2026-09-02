// Fundação das Reuniões v2. As waves seguintes registram captura (W1-A),
// tray/atalho/janela flutuante (W1-B) e resumo/extração (W2) nos registries
// de recorder-contract.ts a partir dos hooks abaixo.
import { registerMeetingsIpc } from '../../ipc/meetings'
import { installFloatingWindow, uninstallFloatingWindow } from './floating-window'
import { installRecorder } from './recorder'
import { installShortcut, uninstallShortcut } from './shortcut'
import { installTray, uninstallTray } from './tray'

export function initMeetings(): void {
  registerMeetingsIpc()
  installRecorder()
}

export function onAppReady(): void {
  installFloatingWindow()
  installTray()
  installShortcut()
}

export function onWillQuit(): void {
  uninstallShortcut()
  uninstallTray()
  uninstallFloatingWindow()
}
