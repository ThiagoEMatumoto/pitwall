import { isHandoffAnswerEnvelope } from '../../../../shared/handoff-answer-envelope'
import { isHandoffWakeEnvelope } from '../../../../shared/handoff-wake-envelope'
import { rehydrateAnswerPending } from './answer-delivery'
import { rehydrateWakePending, sweepOrphansOnBoot } from './handoff-wake'

export interface RestorableQueue {
  restorable(): Array<{ id: string; text: string }>
  restore(): void
}

// Boot da fila durável junto do ledger de handoff. Os envelopes que voltam do
// app.db reidratam o acompanhamento ANTES do restore, que já publica desfechos
// (entregue pelo transcript, descartado por obsoleto); o sweep só expira o ledger
// dos itens que não voltaram.
export function restoreQueueWithLedger(queue: RestorableQueue): void {
  const restored = queue.restorable()
  for (const { id, text } of restored) {
    try {
      if (isHandoffWakeEnvelope(text)) rehydrateWakePending(id)
      else if (isHandoffAnswerEnvelope(text)) rehydrateAnswerPending(id)
    } catch (err) {
      console.error('[handoff-wake] reidratação do item restaurado falhou:', err)
    }
  }
  sweepOrphansOnBoot(new Set(restored.map((r) => r.id)))
  queue.restore()
}
