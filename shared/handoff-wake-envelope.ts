// O envelope que o acordador da mãe (handoff-wake) cola no REPL dela pela fila
// on-idle. Main e renderer precisam reconhecê-lo: chega como turno 'user', mas
// quem escreveu foi o Pitwall, não o usuário.
export const HANDOFF_WAKE_TAG = 'pitwall-handoff-update'

export function isHandoffWakeEnvelope(text: string): boolean {
  return text.trimStart().startsWith(`<${HANDOFF_WAKE_TAG}`)
}
