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
  // Sem sentinela não é AskUserQuestion (nudge do auto mode, submenus do /rewind):
  // não há card pra ele.
  if (menu.kind === 'question' && !menu.options.some((o) => o.sentinel != null)) {
    return { kind: 'blocked', notice: `Há um menu aberto no terminal: responda por lá. ${KEPT}` }
  }
  return { kind: 'blocked', notice: `Há uma pergunta aberta: responda no card. ${KEPT}` }
}

// "Inserir sem enviar" cola sem \r, mas com um menu aberto as letras viram atalhos dele.
export function insertBlockedNotice(menu: TuiMenu | null): string | null {
  return menu ? `Há um menu aberto no terminal: responda-o antes de inserir. ${KEPT}` : null
}

// Escritas do Terminal fora do composer (Shift+Tab do pill de permissão, /rename do
// header): com um menu aberto, Shift+Tab aprova o plano pelo atalho do diálogo e o
// \r do /rename escolhe a opção destacada.
export function terminalWriteBlockedNotice(
  menu: TuiMenu | null,
  action: 'permission' | 'rename',
): string | null {
  if (!menu) return null
  return action === 'permission'
    ? 'Há um menu aberto no terminal: responda-o antes de trocar o modo de permissão.'
    : 'Renomeado aqui, mas o /rename não foi pro claude: há um menu aberto no terminal.'
}

// Teclas encaminhadas cruas pra TUI com o diálogo de plano aberto: Enter aprovaria a
// opção destacada, Shift+Tab aprova pelo atalho do próprio diálogo ("shift+tab to
// approve"), e Esc com rascunho descartaria o plano em vez de mandar o rascunho.
export function forwardKeyNotice(
  seq: string,
  menu: TuiMenu | null,
  draftEmpty: boolean,
): string | null {
  if (menu?.kind !== 'plan') return null
  if (seq === '\r') return 'Enter não aprova o plano: escolha uma opção no card ou escreva o que mudar.'
  if (seq === '\x1b[Z' || seq === '\t')
    return 'Tab não chega ao diálogo do plano (Shift+Tab aprovaria): escolha uma opção no card.'
  if (seq === '\x1b' && !draftEmpty)
    return `Esc descartaria o plano: envie o rascunho como mudanças, ou apague-o para descartar. ${KEPT}`
  return null
}

export const ANSWERED_NOTICE: Record<'plan-feedback' | 'question-other', string> = {
  'plan-feedback': 'Mudanças enviadas ao plano.',
  'question-other': 'Enviado como resposta à pergunta.',
}
