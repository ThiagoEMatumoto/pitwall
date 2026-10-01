// Escrita na filha de handoff com a mesma prova da prompt-queue: só com a caixa de
// input livre na tela relida agora. O paste termina em \r, e um \r sobre um menu de
// permissão (claude) ou sobre o overlay de aprovação (Codex, sem espelho) o aprova.
// Não passa pelo gate 'attention' da fila: responder o handoff_ask é justamente o
// papel deste canal.

import { deliveryVerdict } from '../prompt-queue'
import { tuiMenuWatch, type TuiMenuWatch } from '../tui-menu-watch'
import { injectIntoChild } from './inject'

// \t e \n ficam (o paste os mantém literais); ESC sai — um ESC[201~ no texto
// fecharia o bracketed-paste e o resto viraria tecla crua.
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g

export type ChildWriteRefusal = 'no-screen' | 'menu-open' | 'unparsed' | 'input-dirty'

const REASON: Record<ChildWriteRefusal, string> = {
  'no-screen':
    'a filha não tem espelho da tela (ex.: Codex): o Enter da mensagem poderia aprovar um overlay de aprovação que ninguém viu. Acompanhe por handoff_result; quem intervém é o humano, no terminal dela.',
  'menu-open':
    'há um menu aberto na tela da filha (permissão/pergunta): o Enter da mensagem o responderia. Responda o menu no terminal dela primeiro.',
  unparsed:
    'a tela da filha não mostra a caixa de input livre (pode ser um menu não reconhecido); tente de novo em instantes.',
  'input-dirty': 'há texto não enviado na caixa de input da filha; espere ele sair.',
}

export class ChildWriteRefusedError extends Error {
  constructor(readonly reason: ChildWriteRefusal) {
    super(`Não deu para entregar: ${REASON[reason]}`)
    this.name = 'ChildWriteRefusedError'
  }
}

export async function injectIntoChildGuarded(
  childSessionId: string,
  text: string,
  watch: Pick<TuiMenuWatch, 'has' | 'rescan'> = tuiMenuWatch,
): Promise<void> {
  const scan = watch.has(childSessionId) ? await watch.rescan(childSessionId) : null
  const verdict = deliveryVerdict(null, scan, false, 'now')
  if (verdict !== 'deliver') throw new ChildWriteRefusedError(verdict as ChildWriteRefusal)
  injectIntoChild(childSessionId, text.replace(CONTROL_CHARS, ''))
}
