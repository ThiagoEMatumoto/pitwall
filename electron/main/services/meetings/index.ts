// Fundação das Reuniões v2. As waves seguintes registram captura (W1-A),
// tray/atalho/janela flutuante (W1-B) e resumo/extração (W2) nos registries
// de recorder-contract.ts a partir dos hooks abaixo.
import { registerMeetingsIpc } from '../../ipc/meetings'

export function initMeetings(): void {
  registerMeetingsIpc()
}

export function onAppReady(): void {}

export function onWillQuit(): void {}
