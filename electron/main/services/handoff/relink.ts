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

function sameConversation(a: string, b: string): boolean {
  if (a === b) return true
  const row = getDb()
    .prepare(
      `SELECT 1 FROM sessions x JOIN sessions y ON x.cc_session_id = y.cc_session_id
        WHERE x.id = ? AND y.id = ? AND x.cc_session_id IS NOT NULL`,
    )
    .get(a, b)
  return !!row
}

// Mãe nova não pode estar ABAIXO da filha: A mãe de B e B mãe de A tira as duas
// do filtro "Mães + quem precisa de mim" (as duas viram filhas) e embaralha a árvore.
// Sobe a linha de mães pelo vínculo de cada conversa; teto evita laço em dado sujo.
function assertNotDescendant(childSessionId: string, motherSessionId: string): void {
  let cur: string | null = motherSessionId
  for (let hop = 0; cur && hop < 32; hop++) {
    if (sameConversation(cur, childSessionId)) {
      throw new Error('A mãe escolhida é descendente desta sessão — isso criaria um ciclo.')
    }
    cur = store.getByChildConversation(cur)?.motherSessionId ?? null
  }
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
  if (input.motherSessionId) {
    assertSessionExists(input.motherSessionId)
    assertNotDescendant(input.sessionId, input.motherSessionId)
  }
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
  const child = store.get(input.handoffId)?.childSessionId
  if (child) assertNotDescendant(child, input.motherSessionId)
  const updated = store.setMother(input.handoffId, input.motherSessionId)
  broadcast('handoff:updated', updated)
  return updated
}

// Desvincular = o release do painel (zera child_session_id, encerra o vivo com
// motivo próprio). O evento 'release' é também o que tira a sessão da hierarquia
// mãe/filha: sem ele, um handoff antigo ainda apontando pra ela a manteria filha.
// Solta TODOS os handoffs da conversa (readotada = vários): soltar só o mais recente
// deixava o anterior apontando pra ela, e o botão voltava a oferecer "Re-vincular"
// para uma sessão que a árvore já mostrava como mãe. Vale também para vínculo de
// handoff encerrado (done/failed), que segue aninhando a sessão sob a mãe.
export function detachChild(input: { sessionId: string }): Handoff {
  let last: Handoff | null = null
  for (let guard = 0; guard < 64; guard++) {
    const handoff = store.getByChildConversation(input.sessionId)
    if (!handoff) break
    last = store.release(handoff.id)
    broadcast('handoff:updated', last)
  }
  if (!last) throw new Error('Esta sessão não é filha de nenhum handoff.')
  return last
}
