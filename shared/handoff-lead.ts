import type { Handoff, HandoffStatus } from './types/ipc'

const ACTIVE: ReadonlySet<HandoffStatus> = new Set<HandoffStatus>([
  'pending',
  'approved',
  'running',
  'needs_input',
])

// Quem uma mãe LIDERA: a única resposta a "esta filha ainda responde a ela?".
// O bastão (o que relinka), o diálogo (o que promete), o mapa (o badge) e o Crew
// Dock (o que exibe) leem daqui — com recortes diferentes, uma sessão que só
// delegou uma vez virava "mãe" no bastão sem nunca ter mostrado o badge.
// Dispensada não conta (o humano tirou da frente); interrompida só conta se dá pra
// retomar — retomada, ela reportaria à mãe do handoff.
export function isLedByMother(h: Pick<Handoff, 'status' | 'dismissedAt' | 'resumable'>): boolean {
  if (h.dismissedAt != null) return false
  if (ACTIVE.has(h.status)) return true
  return h.status === 'interrupted' && h.resumable
}

// Vínculo de uma sessão como filha, na régua ÚNICA que a UI (o botão "Tornar
// sessão filha") e o backend (adopt/relink) usam. Antes cada lado tinha a sua: a UI
// ignorava 'interrupted' e dispensados, o backend recusava 'interrupted' — e o
// botão ficava ativo para um clique que sempre falhava.
//  - 'active': responde a uma mãe agora; adotar de novo duplicaria o card.
//  - 'relinkable': o vínculo existe mas foi interrompido ou dispensado; a ação
//    certa é re-vincular o MESMO handoff, não criar outro.
//  - 'none': sem vínculo (nunca foi filha, foi solta, ou o handoff encerrou).
export type ChildLinkState = 'active' | 'relinkable' | 'none'

export function childLinkState(
  h: Pick<Handoff, 'status' | 'dismissedAt' | 'childSessionId'> | null | undefined,
): ChildLinkState {
  if (!h || !h.childSessionId) return 'none'
  if (h.status === 'interrupted') return 'relinkable'
  if (!ACTIVE.has(h.status)) return 'none'
  return h.dismissedAt == null ? 'active' : 'relinkable'
}

// O handoff que responde por uma sessão-filha: o mais recente que aponta pra ela
// (mesma ordem do getByChildSession no main).
export function latestHandoffForChild<T extends Pick<Handoff, 'childSessionId' | 'createdAt'>>(
  handoffs: readonly T[],
  sessionId: string,
): T | null {
  let best: T | null = null
  for (const h of handoffs) {
    if (h.childSessionId !== sessionId) continue
    if (!best || h.createdAt > best.createdAt) best = h
  }
  return best
}
