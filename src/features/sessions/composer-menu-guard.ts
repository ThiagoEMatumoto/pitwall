import type { TuiMenu } from './tui-menu-parser'

// Com um menu aberto na TUI, o envio do composer (paste + \r) cairia no menu e o
// \r escolheria a opção destacada — no diálogo de plano, "Yes, and use auto mode".
// É a regra 'menu-open' do deliveryVerdict (prompt-queue, main), aplicada aqui ao
// envio do próprio usuário: o texto vira a resposta que o menu aceita, ou não sai.
export type ComposerMenuRoute =
  | { kind: 'deliver' }
  | { kind: 'plan-feedback' }
  | { kind: 'question-other'; optionIndex: number }
  | { kind: 'blocked'; notice: string }

const KEPT = 'O rascunho foi mantido.'

export function routeComposerSend(menu: TuiMenu | null): ComposerMenuRoute {
  if (!menu) return { kind: 'deliver' }
  if (menu.kind === 'plan') {
    if (menu.options.some((o) => o.planIntent === 'feedback')) return { kind: 'plan-feedback' }
    return { kind: 'blocked', notice: `O plano espera sua decisão: escolha no card. ${KEPT}` }
  }
  if (menu.kind === 'question' && !menu.multiSelect && !menu.tabs) {
    const other = menu.options.find((o) => o.sentinel === 'other')
    if (other) return { kind: 'question-other', optionIndex: other.index }
  }
  if (menu.kind === 'permission' || menu.kind === 'trust') {
    return {
      kind: 'blocked',
      notice: `Há um pedido de permissão aberto: responda no card. ${KEPT}`,
    }
  }
  return { kind: 'blocked', notice: `Há uma pergunta aberta: responda no card. ${KEPT}` }
}

// "Inserir sem enviar" cola sem \r, mas com um menu aberto as letras viram atalhos dele.
export function insertBlockedNotice(menu: TuiMenu | null): string | null {
  return menu ? `Há um menu aberto no terminal: responda-o antes de inserir. ${KEPT}` : null
}

// Enter com o composer vazio vira \r cru pra TUI: no plano, aprovaria às cegas.
export function emptyEnterNotice(menu: TuiMenu | null): string | null {
  return menu?.kind === 'plan'
    ? 'Enter não aprova o plano: escolha uma opção no card ou escreva o que mudar.'
    : null
}

export const ANSWERED_NOTICE: Record<'plan-feedback' | 'question-other', string> = {
  'plan-feedback': 'Mudanças enviadas ao plano.',
  'question-other': 'Enviado como resposta à pergunta.',
}
