import { activeHandoffCcSessionIds } from './handoff-store'
import { getPref } from './prefs-store'
import type { RestorePlan } from '../../../shared/types/ipc'

import { RESTORE_MODE_PREF } from '../../../shared/restore-mode'

export { RESTORE_MODE_PREF }

// Quem sobe eager no boot, só pelo estado durável. A PromptQueue não entra: ela
// é em memória e está vazia no boot, então "tem mensagem esperando" nunca vale aqui.
export function computeRestorePlan(ccSessionIds: string[]): RestorePlan {
  if (getPref<string>(RESTORE_MODE_PREF, 'lazy') === 'eager') {
    return { mode: 'eager', eagerCcSessionIds: [...new Set(ccSessionIds)] }
  }
  const active = new Set(activeHandoffCcSessionIds())
  return {
    mode: 'lazy',
    eagerCcSessionIds: [...new Set(ccSessionIds)].filter((cc) => active.has(cc)),
  }
}
