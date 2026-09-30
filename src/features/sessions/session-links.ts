import type {
  SessionGraph,
  SessionGraphBatonEdge,
  SessionGraphHandoffEdge,
  SessionGraphNode,
} from '../../../shared/types/session-graph'

export interface ChildLink {
  node: SessionGraphNode
  handoffId: string
  step: string | null
}

export interface LinkedRepo {
  repoId: string
  repoLabel: string
  sessions: SessionGraphNode[]
}

// As relações de UMA sessão lidas do grafo: de onde ela saiu, quem ela delegou,
// de quem herdou (ou pra quem passou) o bastão e quem trabalha nos repos ligados.
export interface SessionLinks {
  mother?: SessionGraphNode
  children: ChildLink[]
  baton: { predecessor?: SessionGraphNode; successor?: SessionGraphNode }
  siblings: SessionGraphNode[]
  linkedRepoSessions: LinkedRepo[]
}

function handoffEdges(graph: SessionGraph): SessionGraphHandoffEdge[] {
  return graph.edges
    .filter((e): e is SessionGraphHandoffEdge => e.kind === 'handoff')
    .sort((a, b) => a.createdAt - b.createdAt)
}

function childrenOf(graph: SessionGraph, byId: Map<string, SessionGraphNode>, id: string) {
  return handoffEdges(graph).flatMap((e): ChildLink[] => {
    const child = e.from === id ? byId.get(e.to) : undefined
    return child ? [{ node: child, handoffId: e.handoffId, step: e.currentStep }] : []
  })
}

function linkedRepos(
  graph: SessionGraph,
  byId: Map<string, SessionGraphNode>,
  current: SessionGraphNode,
): LinkedRepo[] {
  if (!current.repoId || current.status === 'ended') return []
  const byRepo = new Map<string, SessionGraphNode[]>()
  for (const e of graph.edges) {
    if (e.kind !== 'repoDep') continue
    const other =
      e.fromRepoId === current.repoId
        ? { repoId: e.toRepoId, ids: e.toSessionIds }
        : e.toRepoId === current.repoId
          ? { repoId: e.fromRepoId, ids: e.fromSessionIds }
          : null
    if (!other) continue
    const known = byRepo.get(other.repoId) ?? []
    const extra = other.ids
      .map((id) => byId.get(id))
      .filter((n): n is SessionGraphNode => !!n && !known.includes(n))
    byRepo.set(other.repoId, [...known, ...extra])
  }
  return [...byRepo.entries()].map(([repoId, sessions]) => ({
    repoId,
    repoLabel: sessions[0]?.repoLabel ?? repoId,
    sessions,
  }))
}

export function sessionLinks(graph: SessionGraph, sessionId: string): SessionLinks {
  const byId = new Map(graph.nodes.map((n) => [n.sessionId, n]))
  const current = byId.get(sessionId)
  if (!current) return { children: [], baton: {}, siblings: [], linkedRepoSessions: [] }

  const motherEdge = handoffEdges(graph).find((e) => e.to === sessionId)
  const mother = motherEdge ? byId.get(motherEdge.from) : undefined
  const batons = graph.edges.filter((e): e is SessionGraphBatonEdge => e.kind === 'baton')
  const batonIn = batons.find((e) => e.to === sessionId)
  const batonOut = batons.find((e) => e.from === sessionId)
  const siblings = mother
    ? childrenOf(graph, byId, mother.sessionId)
        .map((c) => c.node)
        .filter((n) => n.sessionId !== sessionId)
    : []

  return {
    mother,
    children: childrenOf(graph, byId, sessionId),
    baton: {
      predecessor: batonIn ? byId.get(batonIn.from) : undefined,
      successor: batonOut ? byId.get(batonOut.to) : undefined,
    },
    siblings,
    linkedRepoSessions: linkedRepos(graph, byId, current),
  }
}

// Ordem do Alt+,/Alt+. (anterior/próxima): mãe → irmãs → filhas, com o bastão na linha do tempo da
// própria sessão (antecessora logo antes dela, sucessora logo depois) — assim
// Alt+, e Alt+. são inversos entre as duas pontas de um bastão. As irmãs entram
// pra que, da filha 1, o próximo passo seja a filha 2.
export function linkNavOrder(graph: SessionGraph, sessionId: string): SessionGraphNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.sessionId, n]))
  const current = byId.get(sessionId)
  if (!current) return []
  const links = sessionLinks(graph, sessionId)
  const self = [links.baton.predecessor, current, links.baton.successor]
  const generation = links.mother
    ? childrenOf(graph, byId, links.mother.sessionId).flatMap((c) =>
        c.node.sessionId === sessionId ? self : [c.node],
      )
    : self
  const order = [links.mother, ...generation, ...links.children.map((c) => c.node)].filter(
    (n): n is SessionGraphNode => !!n,
  )
  const unique = [...new Map(order.map((n) => [n.sessionId, n])).values()]
  return unique.length > 1 ? unique : []
}

export interface LinkStep {
  node: SessionGraphNode
  position: number
  total: number
}

// Encerrada não é destino (não há aba pra focar), exceto a filha da crew: o quick
// look dela abre mesmo interrompida.
function reachable(n: SessionGraphNode): boolean {
  return n.status !== 'ended' || n.childOfHandoffId !== null
}

// canOpen: o chamador passa a regra real de abertura (canOpenGraphNode), que
// depende do Crew Dock; o default só olha o grafo.
export function stepLink(
  graph: SessionGraph,
  sessionId: string,
  delta: 1 | -1,
  canOpen: (n: SessionGraphNode) => boolean = reachable,
): LinkStep | null {
  const order = linkNavOrder(graph, sessionId).filter(
    (n) => n.sessionId === sessionId || canOpen(n),
  )
  const index = order.findIndex((n) => n.sessionId === sessionId)
  const next = index + delta
  if (index < 0 || next < 0 || next >= order.length) return null
  return { node: order[next], position: next + 1, total: order.length }
}
