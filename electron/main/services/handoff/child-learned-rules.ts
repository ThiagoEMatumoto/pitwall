// "Sempre permitir para filhas": regras de permissão aprendidas, persistidas em
// app_prefs e somadas ao allow de TODA filha no spawn (handoffChildSettings).
// A derivação e a validação são do spawn-flags (puro); aqui só o I/O da pref.
import { getPref, setPref } from '../prefs-store'
import {
  CHILD_LEARNED_ALLOW_PREF,
  deriveChildAllowRule,
  isLearnableChildRule,
} from '../spawn-flags'

export function getChildLearnedAllow(): string[] {
  const raw = getPref<unknown>(CHILD_LEARNED_ALLOW_PREF, [])
  if (!Array.isArray(raw)) return []
  return raw.filter((r): r is string => typeof r === 'string' && isLearnableChildRule(r))
}

export type LearnChildRuleResult =
  | { ok: true; rule: string; added: boolean }
  | { ok: false; reason: string }

// Deriva do pedido lido da TUI e grava. Nunca grava o que isLearnableChildRule
// recusa (deny/ask, wrappers): a UI pode pedir, o main decide.
export function learnChildRule(
  tool: string | undefined,
  command: string | undefined,
): LearnChildRuleResult {
  const rule = deriveChildAllowRule(tool, command)
  if (!rule) {
    return {
      ok: false,
      reason: 'Esse comando não vira regra automática (é destrutivo, embrulha outro comando ou está na lista de confirmação).',
    }
  }
  const current = getChildLearnedAllow()
  if (current.includes(rule)) return { ok: true, rule, added: false }
  setPref(CHILD_LEARNED_ALLOW_PREF, [...current, rule])
  return { ok: true, rule, added: true }
}
