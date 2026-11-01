// Re-vínculo, troca de mãe e desvínculo de UMA filha, sem relançar o processo.
//
// A adoção (adopt.ts) relança porque precisa fixar apelido e accept-inbound no
// exec. Aqui não: a sessão já nasceu (ou foi relançada) como filha deste handoff —
// o vínculo só se perdeu no banco (interrompido ou dispensado). Reativar o MESMO
// registro devolve o card e o fio mãe→filha sem matar um turno em andamento.

import { getDb } from '../db'
import { broadcast } from '../notify'
import { ptyManager } from '../pty-manager'
import * as store from '../handoff-store'
import { childLinkState, type ChildLinkState } from '../../../../shared/handoff-lead'
import type { Handoff } from '../../../../shared/types/ipc'

function assertSessionExists(sessionId: string): void {
  const row = getDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)
  if (!row) throw new Error(`Sessão não encontrada: ${sessionId}`)
}

// A régua que a UI consulta pra decidir entre "Tornar filha", "Re-vincular",
// "Trocar mãe" e "Desvincular" — a MESMA que o adopt e o relink aplicam.
export function childLink(sessionId: string): { state: ChildLinkState; handoff: Handoff | null } {
  const handoff = store.getByChildConversation(sessionId)
  return { state: childLinkState(handoff), handoff }
}

export function relinkChild(input: { sessionId: string; motherSessionId?: string }): Handoff {
  const handoff = store.getByChildConversation(input.sessionId)
  const state = childLinkState(handoff)
  if (!handoff || state === 'none') {
    throw new Error('Esta sessão não tem vínculo para re-vincular — use "Tornar sessão filha".')
  }
  if (input.motherSessionId) assertSessionExists(input.motherSessionId)
  const relinked = store.relink(handoff.id, {
    childSessionId: input.sessionId,
    childAlive: ptyManager.isRunning(input.sessionId),
    motherSessionId: input.motherSessionId ?? null,
  })
  broadcast('handoff:updated', relinked)
  return relinked
}

export function setChildMother(input: { handoffId: string; motherSessionId: string }): Handoff {
  assertSessionExists(input.motherSessionId)
  const updated = store.setMother(input.handoffId, input.motherSessionId)
  broadcast('handoff:updated', updated)
  return updated
}

// Desvincular = o release do painel (zera child_session_id, encerra o vivo com
// motivo próprio). O evento 'release' é também o que tira a sessão da hierarquia
// mãe/filha: sem ele, um handoff antigo ainda apontando pra ela a manteria filha.
export function detachChild(input: { sessionId: string }): Handoff {
  const handoff = store.getByChildConversation(input.sessionId)
  if (!handoff) throw new Error('Esta sessão não é filha de nenhum handoff.')
  const released = store.release(handoff.id)
  broadcast('handoff:updated', released)
  return released
}
