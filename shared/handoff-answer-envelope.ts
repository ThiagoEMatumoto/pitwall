// O envelope com a resposta a um pedido de handoff (answer-delivery), colado pela
// fila on-idle no REPL de quem perguntou (e de quem escalou). Como o do wake,
// chega como turno 'user' mas quem escreveu foi o Pitwall.
export const HANDOFF_ANSWER_TAG = 'pitwall-answer'

export function isHandoffAnswerEnvelope(text: string): boolean {
  return text.trimStart().startsWith(`<${HANDOFF_ANSWER_TAG}`)
}
