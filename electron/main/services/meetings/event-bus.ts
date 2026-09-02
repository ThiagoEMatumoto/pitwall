// Fonte única dos eventos de reunião: manda pro(s) renderer(s) via broadcast e
// avisa consumidores do próprio main (tray, janela flutuante) — o main não tem
// ipcRenderer pra assinar o próprio canal.
import type { MeetingEvent } from '../../../../shared/types/meetings'
import { broadcast } from '../notify'

export const MEETINGS_EVENT_CHANNEL = 'meetings:event'

type Listener = (event: MeetingEvent) => void
const listeners = new Set<Listener>()

export function onMeetingEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitMeetingEvent(event: MeetingEvent): void {
  broadcast(MEETINGS_EVENT_CHANNEL, event)
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (err) {
      console.warn('[meetings] listener de evento falhou:', err)
    }
  }
}
