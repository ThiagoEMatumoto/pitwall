// PURO: quem é a sessão aberta na modal do terminal, no vocabulário do mapa. O
// header dizia só o nome: aberta a mãe, nada dizia que era a mãe nem de qual
// feature; na tira do rodapé, mãe e filhas eram nomes iguais entre si.
import type { SessionGraphNode } from '../../../shared/types/session-graph'

type RoleSource = Pick<SessionGraphNode, 'isMother' | 'childCount' | 'childOfHandoffId'>

export type PeekRole = { kind: 'mother'; children: number } | { kind: 'child' } | null

export function peekRole(node: RoleSource | undefined): PeekRole {
  if (!node) return null
  if (node.isMother) return { kind: 'mother', children: node.childCount ?? 0 }
  if (node.childOfHandoffId) return { kind: 'child' }
  return null
}

/** Selo do header: o mesmo texto do cartão no mapa ("MÃE · 2"). */
export function peekRoleLabel(role: PeekRole): string | null {
  if (!role) return null
  return role.kind === 'mother' ? `MÃE · ${role.children}` : 'FILHA'
}

/** Ordem da tira: a mãe primeiro, depois as filhas, depois o resto, estável. */
export function stripOrder(ids: string[], roleOf: (id: string) => PeekRole): string[] {
  const rank = (id: string) => {
    const r = roleOf(id)
    return r?.kind === 'mother' ? 0 : r?.kind === 'child' ? 1 : 2
  }
  return ids
    .map((id, i) => ({ id, i, r: rank(id) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.id)
}
