import { matchCombo, resolveCombo, type Combo } from '@/lib/keybindings'
import type { Area } from '@/store/appStore'

export type AttentionKeyAction = 'next' | 'prev' | 'back'

export const ATTENTION_COMMAND_IDS = ['attention.next', 'attention.prev', 'session.back'] as const

const ACTION_BY_ID: Record<(typeof ATTENTION_COMMAND_IDS)[number], AttentionKeyAction> = {
  'attention.next': 'next',
  'attention.prev': 'prev',
  'session.back': 'back',
}

// Qual atalho da fila de atenção o keydown dispara. Na área de Design nenhum: lá
// Alt+A/Alt+Shift+A são do canvas (Alinhar à esquerda) — mesma regra de ceder a
// tecla que o Ctrl+1..9 do AppShell segue.
export function attentionKeyAction(
  e: KeyboardEvent,
  overrides: Record<string, Combo>,
  area: Area,
): AttentionKeyAction | null {
  if (area === 'design') return null
  const id = ATTENTION_COMMAND_IDS.find((cmd) => matchCombo(e, resolveCombo(cmd, overrides)))
  return id ? ACTION_BY_ID[id] : null
}

// Overlays que tomam o teclado: com um deles aberto (Settings, palette, switcher,
// nova sessão, aprovação de handoff) o Alt+A não pode trocar a aba por baixo, e o
// gravador de atalho do Settings precisa RECEBER o Alt+A em vez de a fila
// consumi-lo. O quick look da crew (data-peek-mode) fica de fora de propósito: o
// próprio ciclo abre e fecha o peek entre um pulo e outro.
const BLOCKING_OVERLAY_SELECTOR = [
  '[data-modal-overlay]',
  '[data-keybinding-capture]',
  '[aria-modal="true"]:not([data-peek-mode])',
].join(', ')

export function attentionKeysBlocked(root: ParentNode = document): boolean {
  return root.querySelector(BLOCKING_OVERLAY_SELECTOR) !== null
}
