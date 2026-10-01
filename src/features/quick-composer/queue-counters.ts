import type { PromptQueueSnapshot } from '../../../shared/types/send-prompt'

const msgs = (n: number) => `${n} ${n === 1 ? 'mensagem' : 'mensagens'}`

// Só o que aconteceu (contador > 0), em linguagem de quem usa; o detalhe inteiro
// fica no tooltip. Antes era telemetria crua com seis zeros.
export function counterLines(queue: PromptQueueSnapshot): string[] {
  const c = queue.counters
  const expired = c.expired + c.sessionGone
  return [
    queue.items.length > 0 && `${msgs(queue.items.length)} na fila`,
    c.delivered > 0 && `${msgs(c.delivered)} ${c.delivered === 1 ? 'entregue' : 'entregues'}`,
    c.refusedMenuOpen > 0 &&
      `${msgs(c.refusedMenuOpen)} ${c.refusedMenuOpen === 1 ? 'segurada' : 'seguradas'}: menu aberto na sessão`,
    c.refusedInputDirty > 0 &&
      `${msgs(c.refusedInputDirty)} ${c.refusedInputDirty === 1 ? 'segurada' : 'seguradas'}: texto não enviado no prompt`,
    c.refusedUnparsed > 0 &&
      `${msgs(c.refusedUnparsed)} ${c.refusedUnparsed === 1 ? 'segurada' : 'seguradas'}: tela não reconhecida`,
    expired > 0 && `${msgs(expired)} ${expired === 1 ? 'expirou' : 'expiraram'}`,
  ].filter((l): l is string => !!l)
}
