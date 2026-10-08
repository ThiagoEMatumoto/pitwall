import type { AttentionAction } from '../types/ipc'
import type { TuiMenu } from './tui-menu-parser'

export const COMMAND_SUMMARY_MAX = 80

// O texto vem da tela de outra sessão e vai pra notificação do SO e pro banco:
// sem controle/ANSI, uma linha só, com teto.
export function sanitizeSummary(text: string, max = COMMAND_SUMMARY_MAX): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x1f\x7f]+/g, ' ')
  const clean = flat.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

// "Bash: touch x.txt"; sem pedido estruturado cai na pergunta da TUI.
export function permissionSummary(menu: TuiMenu): string | null {
  const { tool, command } = menu.request ?? {}
  const raw = command ? (tool ? `${tool}: ${command}` : command) : (tool ?? menu.question)
  if (!raw) return null
  const summary = sanitizeSummary(raw)
  return summary === '' ? null : summary
}

export type AttentionChoice = 'approve' | 'always' | 'deny' | 'answer' | 'other'

// Classe da opção escolhida, pelo label REAL (mesmas âncoras do menuActions do
// popover). "switch to auto mode" libera os próximos prompts: conta como always.
export function classifyChoice(menu: TuiMenu, action: AttentionAction): AttentionChoice {
  if (action.kind === 'other') return 'other'
  if (menu.kind !== 'permission' && menu.kind !== 'trust') return 'answer'
  const label = menu.options.find((o) => o.index === action.optionIndex)?.label ?? ''
  if (/^No\b/i.test(label)) return 'deny'
  if (/always allow|don't ask again|allow all edits|remember this directory|auto mode/i.test(label)) {
    return 'always'
  }
  if (/^Yes\b/i.test(label)) return 'approve'
  return 'other'
}
