import type { TuiMenu } from '../tui/tui-menu-parser'

// Cada caminho do chat que ainda manda o usuário ao terminal ("Ir pro Terminal",
// "responda … no terminal"). Contado por kind/motivo: se o card de plano sumisse em
// 100% dos casos, plan:* subiria no mesmo dia (lei do fail-closed).
export const CHAT_FALLBACK_KINDS = [
  'question',
  'plan',
  'permission',
  'trust',
  'question_review',
  'menu',
  'nudge',
  'unknown',
] as const satisfies readonly (TuiMenu['kind'] | 'unknown')[]
export type ChatFallbackKind = (typeof CHAT_FALLBACK_KINDS)[number]

export const CHAT_FALLBACK_REASONS = [
  // Sessão em waiting e nada no chat que responda (menu ausente ou sem card).
  'wait-in-terminal',
  // Pergunta/plano pendente no JSONL sem o menu vivo correspondente.
  'pending-without-menu',
  // Diálogo de plano sem nenhuma opção reconhecida.
  'no-options',
  // Popover de atenção com menu não reconhecido.
  'popover-unrecognized',
] as const
export type ChatFallbackReason = (typeof CHAT_FALLBACK_REASONS)[number]

export interface ChatFallbackCounters {
  // `${kind}:${reason}` → vezes que o fallback ficou na tela (persistido em app_prefs).
  chatFallbacks: Record<string, number>
  lastChatFallbackAt: number | null
}
