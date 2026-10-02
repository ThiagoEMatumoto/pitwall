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
