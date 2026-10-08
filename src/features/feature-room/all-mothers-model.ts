import type { AttentionItem } from '../../../shared/types/attention'
import type { SessionGraphNode } from '../../../shared/types/session-graph'

interface EdgeLike {
  kind: string
  from?: string
  to?: string
}

// Filhas de handoff por mãe, só com a mãe em uso (mesmo corte de roomMothers).
export function childIdsByMother(
  edges: ReadonlyArray<EdgeLike>,
  inUse: ReadonlySet<string>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const e of edges) {
    if (e.kind !== 'handoff' || !e.from || !e.to || !inUse.has(e.from)) continue
    const kids = out.get(e.from) ?? new Set<string>()
    kids.add(e.to)
    out.set(e.from, kids)
  }
  return out
}

// Mãe da Room = sessão de TOPO em uso, de qualquer feature. isMother
// (session-graph.ts:247) só fica true com 1+ filha; a recém-criada tem 0.
// Sessão de topo SEM feature só entra se já delegou (isMother): sem esse corte,
// todo terminal avulso do usuário viraria tile.
export function allMothers(
  nodes: ReadonlyArray<SessionGraphNode>,
  edges: ReadonlyArray<EdgeLike>,
  inUse: ReadonlySet<string>,
): SessionGraphNode[] {
  const underMother = new Set<string>()
  for (const kids of childIdsByMother(edges, inUse).values())
    for (const k of kids) underMother.add(k)
  return nodes.filter(
    (n) =>
      inUse.has(n.sessionId) &&
      !underMother.has(n.sessionId) &&
      (n.featureId != null || n.isMother === true),
  )
}

// Recorte do needYou (humanQueue, calculado UMA vez pela superfície) que é desta
// mãe: os itens dela e os das filhas. Ninguém recalcula a regra de atenção.
export function needYouFor(
  needYou: AttentionItem[],
  mother: SessionGraphNode,
  childIdsOf: (motherId: string) => ReadonlySet<string>,
): AttentionItem[] {
  const kids = childIdsOf(mother.sessionId)
  return needYou.filter(
    (i) => i.sessionId === mother.sessionId || (i.sessionId != null && kids.has(i.sessionId)),
  )
}

// Chave do pin: o resume cria um sessions.id novo (ipc/sessions.ts, o
// internalSessionId do resume) e mantém o ccSessionId. Pinar pelo id interno
// perderia o pin a cada retomada.
export function pinKey(node: Pick<SessionGraphNode, 'sessionId' | 'ccSessionId'>): string {
  return node.ccSessionId ?? node.sessionId
}

// Fixadas primeiro (na ordem em que foram fixadas), depois as que precisam de
// você, depois por atividade. `frozen` (ids na ordem da tela) vale enquanto o
// usuário digita num tile: nada muda de lugar, mãe nova entra no fim e mãe que
// sumiu sai sem deixar buraco.
export function orderTiles(
  mothers: SessionGraphNode[],
  needCount: (sessionId: string) => number,
  pins: readonly string[],
  frozen: readonly string[] | null,
): SessionGraphNode[] {
  const byId = new Map(mothers.map((m) => [m.sessionId, m]))
  if (frozen) {
    const kept = frozen.filter((id) => byId.has(id))
    const added = mothers.filter((m) => !frozen.includes(m.sessionId)).map((m) => m.sessionId)
    return [...kept, ...added].map((id) => byId.get(id)!)
  }
  const byPin = new Map(mothers.map((m) => [pinKey(m), m]))
  const pinned = pins.flatMap((k) => {
    const m = byPin.get(k)
    return m ? [m] : []
  })
  const pinnedIds = new Set(pinned.map((m) => m.sessionId))
  const rest = mothers
    .filter((m) => !pinnedIds.has(m.sessionId))
    .sort(
      (a, b) =>
        Number(needCount(b.sessionId) > 0) - Number(needCount(a.sessionId) > 0) ||
        (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) ||
        a.sessionId.localeCompare(b.sessionId),
    )
  return [...pinned, ...rest]
}
