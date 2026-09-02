import { globalShortcut } from 'electron'
import { toggleRecording } from './recording-actions'

export const MEETING_SHORTCUT = 'CommandOrControl+Shift+R'

export function installShortcut(): void {
  try {
    const ok = globalShortcut.register(MEETING_SHORTCUT, () => {
      toggleRecording().catch((err) => console.warn('[meetings] atalho falhou:', err))
    })
    if (!ok) console.warn(`[meetings] atalho ${MEETING_SHORTCUT} já em uso por outro app`)
  } catch (err) {
    console.warn('[meetings] atalho global indisponível', err)
  }
}

export function uninstallShortcut(): void {
  try {
    globalShortcut.unregisterAll()
  } catch (err) {
    console.warn('[meetings] falha ao remover atalho global', err)
  }
}
