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

// Mãe da Room = sessão RAIZ (isRoot: o humano abriu, não nasceu de handoff) em
// uso e não encerrada, de qualquer feature ou sem feature. Não confundir com
// isMother (tem filhas): a recém-aberta tem 0 filhas e já é mãe aqui. A sucessora
// do bastão de uma filha continua filha (conta só no tile da mãe).
// Filha ÓRFÃ (a mãe encerrou ou saiu de uso) vira tile próprio: sem ninguém em
// uso liderando, quem a dirige é o humano — o mesmo critério de "mãe = sessão
// do humano" que já vale para a filha solta por release(). Sem isto ela sumia da
// Room, e os pedidos dela ficavam sem tile. Só conta quem ainda adota um handoff
// (childOfHandoffId): a antecessora de um bastão de filha não volta como tile.
export function allMothers(
  graph: { nodes: ReadonlyArray<SessionGraphNode>; edges: ReadonlyArray<EdgeLike> },
  inUse: ReadonlySet<string>,
): SessionGraphNode[] {
  const led = new Set([...childIdsByMother(graph.edges, inUse).values()].flatMap((k) => [...k]))
  return graph.nodes.filter(
    (n) =>
      n.status !== 'ended' &&
      inUse.has(n.sessionId) &&
      (n.isRoot === true || (n.childOfHandoffId != null && !led.has(n.sessionId))),
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
