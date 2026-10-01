// O envelope que o agent-bus (formatAskEnvelope) cola na PTY do destino. Main e
// renderer precisam reconhecê-lo: no transcript chega como turno 'user' e na fila
// como mensagem comum, mas quem escreveu foi outra sessão, não o usuário.
export function isAgentAskEnvelope(text: string): boolean {
  return text.trimStart().startsWith('<pitwall-ask ')
}
