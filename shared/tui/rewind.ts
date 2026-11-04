import type { TuiMenu } from './tui-menu-parser'

// "Voltar a este ponto" do chat: Esc-Esc com o composer da CLI vazio abre o seletor do
// /rewind, com o cursor em "(current)" (sondas rewind-populated, claude 2.1.318). A lista
// tem uma parada por mensagem do usuário, da mais antiga à mais nova, e termina em
// "(current)". Sem fullscreen ela cabe inteira na tela de 45 linhas; com fullscreen ela
// rola, e as linhas "↑ N more"/"↓ N more" dizem quantas paradas ficaram fora da janela.

export interface RewindTarget {
  // Texto da mensagem no chat.
  text: string
  // 1 = a última mensagem do usuário; 2 = a anterior; …
  fromEnd: number
  // Mensagens do usuário no chat, da mais antiga à mais nova. Com elas, o Enter também exige
  // que as outras paradas visíveis batam com o chat: depois de um Restore conversation o
  // chat segue mostrando o ramo desfeito, e o mesmo fromEnd cai em outra mensagem, às
  // vezes com o mesmo texto ("sim", "continue").
  chat?: string[]
}

export const REWIND_OPEN_KEYS = ['\x1b', '\x1b']
// Gap entre os dois Esc (o da sonda): rápido demais e o 2º Esc chega antes do 1º ser lido.
export const REWIND_OPEN_DELAY_MS = 200
// Setas no seletor: a sonda andou com 300ms; a TUI redesenha bem antes disso.
export const REWIND_NAV_DELAY_MS = 60

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const CURRENT_LABEL = '(current)'
const PICKER_FOOTER_RE = /^Enter to continue · Esc to cancel$/

export function isRewindPicker(menu: TuiMenu | null): menu is TuiMenu {
  return (
    menu != null &&
    menu.kind === 'menu' &&
    menu.question === 'Rewind' &&
    PICKER_FOOTER_RE.test(menu.footer ?? '') &&
    menu.cursorIndex != null
  )
}

interface Position {
  cursor: number
  total: number
  // Posição absoluta da 1ª opção visível.
  offset: number
}

// Sem a contagem de uma borda rolada não dá para saber onde o cursor está na lista.
function position(menu: TuiMenu): Position | null {
  if (menu.moreAbove && menu.moreAboveCount == null) return null
  if (menu.moreBelow && menu.moreBelowCount == null) return null
  const offset = menu.moreAboveCount ?? 0
  const total = offset + menu.options.length + (menu.moreBelowCount ?? 0)
  const k = menu.options.findIndex((o) => o.index === menu.cursorIndex)
  if (k < 0) return null
  return { cursor: offset + k, total, offset }
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

// O seletor mostra a mensagem numa linha; se ela não couber, termina em "…".
export function rewindLabelMatches(label: string, text: string): boolean {
  const l = norm(label)
  const t = norm(text)
  if (l === '' || t === '') return false
  if (l.endsWith('…')) {
    const head = l.slice(0, -1).trimEnd()
    return head.length > 0 && t.startsWith(head)
  }
  return l === t
}

// Setas do cursor atual até a parada do alvo. null = o seletor não diz onde estamos ou o
// alvo não existe nele (a lista é mais curta que o fromEnd).
export function rewindNavKeys(menu: TuiMenu, target: RewindTarget): string[] | null {
  if (!isRewindPicker(menu) || target.fromEnd < 1) return null
  const pos = position(menu)
  if (!pos) return null
  const want = pos.total - 1 - target.fromEnd
  if (want < 0) return null
  const delta = want - pos.cursor
  return Array<string>(Math.abs(delta)).fill(delta > 0 ? DOWN : UP)
}

// O cursor está na parada do alvo E ela mostra o texto da mensagem. Só aí o Enter é
// seguro: ele abre o submenu de restaurar daquela mensagem.
export function rewindCursorOnTarget(menu: TuiMenu, target: RewindTarget): boolean {
  if (!isRewindPicker(menu)) return false
  const pos = position(menu)
  if (!pos || pos.cursor !== pos.total - 1 - target.fromEnd) return false
  const opt = menu.options.find((o) => o.index === menu.cursorIndex)
  if (opt == null || opt.label === CURRENT_LABEL || !rewindLabelMatches(opt.label, target.text))
    return false
  return target.chat == null || stopsMatchChat(menu, pos, target.chat)
}

function stopsMatchChat(menu: TuiMenu, pos: Position, chat: string[]): boolean {
  return menu.options.every((o, k) => {
    if (o.label === CURRENT_LABEL) return true
    const text = chat[chat.length - (pos.total - 1 - (pos.offset + k))]
    return text != null && rewindLabelMatches(o.label, text)
  })
}
