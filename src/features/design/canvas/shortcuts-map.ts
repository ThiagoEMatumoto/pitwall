// Pure keymap of the design canvas (plan-renderer §F / plan-part2 item 13).
// No DOM here: resolveShortcut() takes the key facts and returns an action,
// so the table is testable and drives the ShortcutsPanel listing too.
//
// Global app combos handled in capture phase by AppShell (Cmd+K, Cmd+Shift+A,
// Cmd+N, Cmd+J, Cmd+B) are deliberately absent; the hook also skips events
// they already defaultPrevented.

import { matchCombo, type Combo } from '@/lib/keybindings'
import type { DesignTool } from '@/store/designStore'
import type { AlignMode, ZOrderDirection } from './draw-tools'

export type ShortcutAction =
  | { type: 'tool'; tool: DesignTool }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'delete' }
  | { type: 'duplicate' }
  | { type: 'group' }
  | { type: 'ungroup' }
  | { type: 'autolayout' }
  | { type: 'zorder'; dir: ZOrderDirection }
  | { type: 'align'; mode: AlignMode }
  | { type: 'nudge'; dx: number; dy: number }
  | { type: 'zoom'; to: 'fit' | 'reset' | 'in' | 'out' }
  | { type: 'scope'; dir: 'enter' | 'exit' }
  | { type: 'selectAll' }
  | { type: 'copy' }
  | { type: 'cut' }
  | { type: 'paste' }
  | { type: 'textCommit' }
  | { type: 'shortcutsPanel' }

export type ShortcutGroup = 'Ferramentas' | 'Edição' | 'Arranjo' | 'Alinhamento' | 'Navegação'

export interface ShortcutDef {
  combo: Combo
  action: ShortcutAction
  label: string
  group: ShortcutGroup
  // Extra combos listed under the same label (e.g. Backspace for Delete).
  aliases?: Combo[]
}

export type KeyFacts = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'
>

const NUDGE_SMALL = 1
const NUDGE_LARGE = 10

const tool = (key: string, t: DesignTool, label: string): ShortcutDef => ({
  combo: { key },
  action: { type: 'tool', tool: t },
  label,
  group: 'Ferramentas',
})

// Alt+letter can produce a dead key or a different `key` (å on macOS),
// so alignment combos match by physical code.
const align = (code: string, mode: AlignMode, label: string): ShortcutDef => ({
  combo: { alt: true, code },
  action: { type: 'align', mode },
  label,
  group: 'Alinhamento',
})

export const SHORTCUTS: readonly ShortcutDef[] = [
  tool('v', 'move', 'Selecionar (mover)'),
  tool('f', 'frame', 'Frame'),
  tool('r', 'rect', 'Retângulo'),
  tool('o', 'ellipse', 'Elipse'),
  tool('t', 'text', 'Texto'),
  tool('h', 'hand', 'Mão (pan)'),

  {
    combo: { mod: true, key: 'z' },
    action: { type: 'undo' },
    label: 'Desfazer',
    group: 'Edição',
  },
  {
    combo: { mod: true, shift: true, key: 'z' },
    action: { type: 'redo' },
    label: 'Refazer',
    group: 'Edição',
  },
  {
    combo: { key: 'Delete' },
    aliases: [{ key: 'Backspace' }],
    action: { type: 'delete' },
    label: 'Excluir',
    group: 'Edição',
  },
  {
    combo: { mod: true, key: 'd' },
    action: { type: 'duplicate' },
    label: 'Duplicar',
    group: 'Edição',
  },
  {
    combo: { mod: true, key: 'c' },
    action: { type: 'copy' },
    label: 'Copiar',
    group: 'Edição',
  },
  {
    combo: { mod: true, key: 'x' },
    action: { type: 'cut' },
    label: 'Recortar',
    group: 'Edição',
  },
  {
    combo: { mod: true, key: 'v' },
    action: { type: 'paste' },
    label: 'Colar',
    group: 'Edição',
  },
  {
    combo: { mod: true, key: 'a' },
    action: { type: 'selectAll' },
    label: 'Selecionar irmãos',
    group: 'Edição',
  },
  {
    combo: { mod: true, key: 'Enter' },
    action: { type: 'textCommit' },
    label: 'Editar / confirmar texto',
    group: 'Edição',
  },

  {
    combo: { mod: true, key: 'g' },
    action: { type: 'group' },
    label: 'Agrupar em frame',
    group: 'Arranjo',
  },
  {
    combo: { mod: true, shift: true, key: 'g' },
    action: { type: 'ungroup' },
    label: 'Desagrupar',
    group: 'Arranjo',
  },
  {
    combo: { shift: true, key: 'a' },
    action: { type: 'autolayout' },
    label: 'Auto-layout (flex)',
    group: 'Arranjo',
  },
  {
    combo: { mod: true, code: 'BracketRight' },
    action: { type: 'zorder', dir: 'up' },
    label: 'Trazer para frente',
    group: 'Arranjo',
  },
  {
    combo: { mod: true, code: 'BracketLeft' },
    action: { type: 'zorder', dir: 'down' },
    label: 'Enviar para trás',
    group: 'Arranjo',
  },
  {
    combo: { mod: true, alt: true, code: 'BracketRight' },
    action: { type: 'zorder', dir: 'top' },
    label: 'Trazer para o topo',
    group: 'Arranjo',
  },
  {
    combo: { mod: true, alt: true, code: 'BracketLeft' },
    action: { type: 'zorder', dir: 'bottom' },
    label: 'Enviar para o fundo',
    group: 'Arranjo',
  },

  align('KeyA', 'left', 'Alinhar à esquerda'),
  align('KeyD', 'right', 'Alinhar à direita'),
  align('KeyW', 'top', 'Alinhar ao topo'),
  align('KeyS', 'bottom', 'Alinhar à base'),
  align('KeyH', 'centerH', 'Centralizar na horizontal'),
  align('KeyV', 'centerV', 'Centralizar na vertical'),
  {
    combo: { key: 'ArrowLeft' },
    action: { type: 'nudge', dx: -NUDGE_SMALL, dy: 0 },
    label: 'Mover 1px',
    group: 'Alinhamento',
  },
  {
    combo: { shift: true, key: 'ArrowLeft' },
    action: { type: 'nudge', dx: -NUDGE_LARGE, dy: 0 },
    label: 'Mover 10px',
    group: 'Alinhamento',
  },
  {
    combo: { key: 'ArrowRight' },
    action: { type: 'nudge', dx: NUDGE_SMALL, dy: 0 },
    label: 'Mover 1px',
    group: 'Alinhamento',
  },
  {
    combo: { shift: true, key: 'ArrowRight' },
    action: { type: 'nudge', dx: NUDGE_LARGE, dy: 0 },
    label: 'Mover 10px',
    group: 'Alinhamento',
  },
  {
    combo: { key: 'ArrowUp' },
    action: { type: 'nudge', dx: 0, dy: -NUDGE_SMALL },
    label: 'Mover 1px',
    group: 'Alinhamento',
  },
  {
    combo: { shift: true, key: 'ArrowUp' },
    action: { type: 'nudge', dx: 0, dy: -NUDGE_LARGE },
    label: 'Mover 10px',
    group: 'Alinhamento',
  },
  {
    combo: { key: 'ArrowDown' },
    action: { type: 'nudge', dx: 0, dy: NUDGE_SMALL },
    label: 'Mover 1px',
    group: 'Alinhamento',
  },
  {
    combo: { shift: true, key: 'ArrowDown' },
    action: { type: 'nudge', dx: 0, dy: NUDGE_LARGE },
    label: 'Mover 10px',
    group: 'Alinhamento',
  },

  {
    combo: { mod: true, key: '0' },
    action: { type: 'zoom', to: 'fit' },
    label: 'Ajustar ao conteúdo',
    group: 'Navegação',
  },
  {
    combo: { mod: true, key: '1' },
    action: { type: 'zoom', to: 'reset' },
    label: 'Zoom 100%',
    group: 'Navegação',
  },
  {
    combo: { mod: true, code: 'Equal' },
    aliases: [
      { mod: true, shift: true, code: 'Equal' },
      { mod: true, code: 'NumpadAdd' },
    ],
    action: { type: 'zoom', to: 'in' },
    label: 'Aproximar',
    group: 'Navegação',
  },
  {
    combo: { mod: true, code: 'Minus' },
    aliases: [{ mod: true, code: 'NumpadSubtract' }],
    action: { type: 'zoom', to: 'out' },
    label: 'Afastar',
    group: 'Navegação',
  },
  {
    combo: { key: 'Enter' },
    action: { type: 'scope', dir: 'enter' },
    label: 'Entrar no grupo',
    group: 'Navegação',
  },
  {
    combo: { key: 'Escape' },
    action: { type: 'scope', dir: 'exit' },
    label: 'Subir / limpar seleção',
    group: 'Navegação',
  },
  {
    combo: { mod: true, shift: true, code: 'Slash' },
    action: { type: 'shortcutsPanel' },
    label: 'Painel de atalhos',
    group: 'Navegação',
  },
]

export function resolveShortcut(e: KeyFacts): ShortcutAction | null {
  const event = e as KeyboardEvent
  for (const def of SHORTCUTS) {
    if (matchCombo(event, def.combo)) return def.action
    if (def.aliases?.some((c) => matchCombo(event, c))) return def.action
  }
  return null
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}
