// A mãe chama a filha concluída que dorme (handoff_message): sem processo, o
// SendMessage nativo não a alcança. Acorda pelo mesmo relance do resume e entrega
// pela fila on-idle, que espera a TUI subir e só escreve com a caixa de input
// livre. Colar logo depois do spawn cairia numa tela ainda sem prompt.
//
// O handoff não é reaberto: segue done, e a filha responde por SendMessage. Um
// handoff_report dela agora seria um reportDuplicate que não acorda ninguém, por
// isso o texto entregue diz a ela como responder.
import { waitPtyReady } from '../dormant-panes'
import * as handoffStore from '../handoff-store'
import { ptyManager } from '../pty-manager'
import { tuiMenuWatch } from '../tui-menu-watch'
import { attr, sanitizeBody } from './envelope-text'
import { getWakeQueue } from './handoff-wake'
import { wakeHandoffChild } from './spawn-child'
import type { Handoff } from '../../../../shared/types/ipc'

export interface AsleepChildDelivery {
  childSessionId: string
  childAlias: string | null
  // false = na fila: entra quando a TUI da filha ficar ociosa.
  delivered: boolean
}

// O que a filha lê ao acordar. O apelido da mãe é o `to` do SendMessage; sem ele
// vale a regra do briefing (o `from` da mensagem que ela já recebeu). O texto da
// mãe sai sem caracteres de controle: a fila o escreve num bracketed-paste, e um
// ESC[201~ fecharia o paste com o resto virando tecla crua.
export function asleepChildMessage(
  handoffId: string,
  motherAlias: string | null,
  text: string,
): string {
  const to = motherAlias
    ? `SendMessage({ to: "${attr(motherAlias)}" })`
    : 'SendMessage (o `to` é o `from` das mensagens que ela já te mandou)'
  return [
    `[Pitwall] Você dormia e a sua mãe te acordou com a mensagem abaixo. O handoff ${handoffId} já foi entregue e continua concluído: responda a ela por ${to}, não por handoff_report.`,
    '',
    sanitizeBody(text),
  ].join('\n')
}

// Ordem das escritas: primeiro o processo, depois a mensagem. Se só a segunda
// falha, a filha fica acordada e ociosa (o hibernador a põe para dormir de novo)
// e a mãe recebe o motivo e o caminho que agora funciona, o SendMessage.
export async function messageAsleepChild(
  handoff: Handoff,
  text: string,
  fromSessionId: string | null,
): Promise<AsleepChildDelivery> {
  let childSessionId: string
  try {
    childSessionId = wakeHandoffChild(handoff.id).id
  } catch (err) {
    throw new Error(
      `Não deu para acordar a filha do handoff ${handoff.id}: ${err instanceof Error ? err.message : String(err)}. Nada foi entregue.`,
    )
  }
  const childAlias = handoffStore.childAlias(childSessionId)
  const undelivered = (why: string, alive: boolean): Error =>
    new Error(
      alive
        ? `A filha do handoff ${handoff.id} foi acordada, mas a mensagem não foi entregue (${why}). Ela está viva agora: mande por SendMessage${childAlias ? `({ to: "${childAlias}" })` : ''}.`
        : `A filha do handoff ${handoff.id} foi acordada, mas a mensagem não foi entregue (${why}).`,
    )

  const ready = await waitPtyReady(childSessionId, {
    isRunning: (id) => ptyManager.isRunning(id),
    screen: (id) => (tuiMenuWatch.has(id) ? tuiMenuWatch.rescan(id) : Promise.resolve(null)),
  })
  if (ready === 'exited') throw undelivered('o processo dela saiu logo depois de subir', false)
  if (ready === 'timeout') throw undelivered('a TUI dela não ficou pronta a tempo', true)

  const queue = getWakeQueue()
  if (!queue) throw undelivered('a fila de entrega não está disponível', true)
  const sent = await queue.send({
    sessionId: childSessionId,
    text: asleepChildMessage(handoff.id, handoffStore.childAlias(handoff.motherSessionId), text),
    when: 'on-idle',
    ...(fromSessionId ? { fromSessionId } : {}),
  })
  if (!sent.ok) throw undelivered(sent.detail ?? sent.error, ptyManager.isRunning(childSessionId))
  return { childSessionId, childAlias, delivered: sent.delivered }
}
