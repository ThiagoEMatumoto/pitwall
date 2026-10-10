import { activeHandoffCcSessionIds } from './handoff-store'
import { getPref } from './prefs-store'
import type { RestorePlan } from '../../../shared/types/ipc'

import { DEFAULT_LAZY_RESTORE, LAZY_RESTORE_PREF } from '../../../shared/lazy-restore'

export { LAZY_RESTORE_PREF }

// Só o booleano true liga: valor legado ou corrompido cai no default (desligado).
export function lazyRestoreEnabled(): boolean {
  return getPref<unknown>(LAZY_RESTORE_PREF, DEFAULT_LAZY_RESTORE) === true
}

// Quem sobe eager no boot, só pelo estado durável. A PromptQueue não entra: ela
// é em memória e está vazia no boot, então "tem mensagem esperando" nunca vale aqui.
// enabled: o main real passa o valor congelado no boot (ipc/dormant-panes).
export function computeRestorePlan(
  ccSessionIds: string[],
  enabled = lazyRestoreEnabled(),
): RestorePlan {
  if (!enabled) {
    return { mode: 'eager', eagerCcSessionIds: [...new Set(ccSessionIds)] }
  }
  const active = new Set(activeHandoffCcSessionIds())
  return {
    mode: 'lazy',
    eagerCcSessionIds: [...new Set(ccSessionIds)].filter((cc) => active.has(cc)),
  }
}
