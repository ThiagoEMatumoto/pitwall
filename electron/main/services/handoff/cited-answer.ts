// SendMessage da mãe → filha que cita o id de um pedido aberto é a resposta da mãe
// àquele pedido: mesmo efeito de handoff_answer(requestId, text). Só vemos a
// CHAMADA no transcript da mãe; o texto já chegou à filha pelo canal
// cross-session, então o <pitwall-answer> não é reentregue (seria um 2º turno da
// filha com o mesmo conteúdo). human_only não fecha: só o humano resolve, e a
// tentativa fica na trilha.
import * as handoffStore from '../handoff-store'
import * as requestStore from '../handoff-requests'
import type { Handoff } from '../../../../shared/types/ipc'
import type { ObservedSendMessage } from '../session-link-pulse'

export function answerCitedRequests(e: ObservedSendMessage): Handoff | null {
  const message = e.message
  if (!message) return null
  const h = handoffStore.getByChildSession(e.toSessionId)
  if (!h || !h.motherSessionId || h.motherSessionId !== e.fromSessionId) return null
  if (h.status !== 'running' && h.status !== 'needs_input') return null
  const cited = requestStore.listOpen({ handoffId: h.id }).filter((r) => message.includes(r.id))
  if (cited.length === 0) return null
  for (const r of cited) {
    if (r.resolver === 'human_only') {
      handoffStore.recordEvent(h.id, 'request_answer_refused', `${r.id} human_only via SendMessage`)
      continue
    }
    requestStore.answerRequest(r.id, { text: message, by: 'mother' })
  }
  return handoffStore.get(h.id)
}
