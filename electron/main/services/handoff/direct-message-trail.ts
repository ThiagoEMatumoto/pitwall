// SendMessage filha→mãe é canal fora do Pitwall: só vemos a CHAMADA no transcript
// da filha, não a entrega (pode ficar held do lado da mãe). Registramos como
// tentativa observada em handoff_events (event='child_direct_message').
//
// Limites conhecidos:
// (a) a latência é a da releitura do tail (até o fim do turno da filha);
// (b) só filha Claude: o Codex não tem SendMessage;
// (c) após um restart, chamada mais velha que SEND_MESSAGE_FRESH_MS na 1ª leitura
//     do transcript é tratada como histórico e não é registrada;
// (d) é a tentativa, não a entrega — não acorda a mãe nem suprime o wake.
import * as handoffStore from '../handoff-store'
import { sanitizeBody } from '../agent-bus'
import type { ObservedSendMessage } from '../session-link-pulse'

const PREVIEW_CHARS = 200

export function recordChildDirectMessage(e: ObservedSendMessage): void {
  const h = handoffStore.getByChildSession(e.fromSessionId)
  if (!h || h.motherSessionId !== e.toSessionId) return
  if (h.status !== 'running' && h.status !== 'needs_input') return
  const preview = e.message ? sanitizeBody(e.message).slice(0, PREVIEW_CHARS) : null
  handoffStore.recordEvent(
    h.id,
    'child_direct_message',
    JSON.stringify({ toolUseId: e.toolUseId, chars: e.message?.length ?? null, preview }),
  )
}
