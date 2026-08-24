// Qual sessão está no pane ativo do renderer — espelho local do
// sessions.setRendererFocus (o AppShell alimenta os dois no mesmo effect). O
// modo voz usa isto pra falar SÓ o resumo da sessão que o usuário está olhando;
// as demais mostram o chip em silêncio.

let activeCcSessionId: string | null = null

export function setActiveVoiceSession(ccSessionId: string | null): void {
  activeCcSessionId = ccSessionId
}

export function isActiveVoiceSession(ccSessionId: string | null): boolean {
  return ccSessionId !== null && ccSessionId === activeCcSessionId
}
