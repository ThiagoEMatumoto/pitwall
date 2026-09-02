// Fundação das Reuniões v2. As waves seguintes registram captura (W1-A),
// tray/atalho/janela flutuante (W1-B) e resumo/extração (W2) nos registries
// de recorder-contract.ts a partir dos hooks abaixo.
import { registerMeetingsIpc } from '../../ipc/meetings'
import { installActionItemBatch } from './action-item-batch'
import { installFloatingWindow, uninstallFloatingWindow } from './floating-window'
import { installDetector, uninstallDetector } from './meeting-detector'
import { installPostProcess } from './post-process'
import { installRecorder } from './recorder'
import { installShortcut, uninstallShortcut } from './shortcut'
import { installSpeakerRename } from './speaker-rename'
import { installTray, uninstallTray } from './tray'

export function initMeetings(): void {
  registerMeetingsIpc()
  installRecorder()
  installPostProcess()
  installSpeakerRename()
  installActionItemBatch()
}

export function onAppReady(): void {
  installFloatingWindow()
  installTray()
  installShortcut()
  installDetector()
}

export function onWillQuit(): void {
  uninstallDetector()
  uninstallShortcut()
  uninstallTray()
  uninstallFloatingWindow()
}
