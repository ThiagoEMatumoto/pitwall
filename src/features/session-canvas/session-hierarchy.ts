import type { SessionGraphNode } from '../../../shared/types/session-graph'

// Árvore mãe → filhas da tela de projeto. Pura (testável): recebe os nós do grafo
// e devolve o que a lista desenha. A régua de "quem é filha de quem" é a do grafo
// (hierarchyMotherId), que olha QUALQUER handoff histórico — filha dispensada ou
// antiga não volta ao topo.
export interface SessionTreeItem {
  sessionId: string
  // null = a mãe não está viva neste projeto (encerrada ou de outro projeto): o
  // grupo aparece com o nome dela, sem linha clicável própria.
  node: SessionGraphNode | null
  title: string
  needsYou: boolean
  children: SessionTreeItem[]
  // Descendentes (filhas, netas…) e quantos deles precisam de você.
  descendants: number
  descendantsNeedingYou: number
}

export function nodeNeedsYou(n: Pick<SessionGraphNode, 'attentionReason'>): boolean {
  return n.attentionReason != null
}

export function buildSessionTree(nodes: SessionGraphNode[], projectId: string): SessionTreeItem[] {
  const visible = nodes.filter((n) => n.projectId === projectId && n.status !== 'ended')
  const visibleIds = new Set(visible.map((n) => n.sessionId))
  const byMother = new Map<string, SessionGraphNode[]>()
  for (const n of visible) {
    const mother = n.hierarchyMotherId
    if (!mother || mother === n.sessionId) continue
    byMother.set(mother, [...(byMother.get(mother) ?? []), n])
  }
  const titleOf = new Map(nodes.map((n) => [n.sessionId, n.title]))
  const placed = new Set<string>()

  const build = (
    sessionId: string,
    node: SessionGraphNode | null,
    title: string,
  ): SessionTreeItem => {
    placed.add(sessionId)
    const children = (byMother.get(sessionId) ?? [])
      .filter((c) => !placed.has(c.sessionId))
      .map((c) => build(c.sessionId, c, c.title))
    return {
      sessionId,
      node,
      title,
      needsYou: node ? nodeNeedsYou(node) : false,
      children,
      descendants: children.reduce((acc, c) => acc + 1 + c.descendants, 0),
      descendantsNeedingYou: children.reduce(
        (acc, c) => acc + Number(c.needsYou) + c.descendantsNeedingYou,
        0,
      ),
    }
  }

  const roots: SessionTreeItem[] = []
  for (const n of visible) {
    if (!n.hierarchyMotherId || n.hierarchyMotherId === n.sessionId)
      roots.push(build(n.sessionId, n, n.title))
  }
  // Filhas cuja mãe não está viva aqui: agrupadas sob o nome da mãe, nunca soltas
  // no topo como se fossem mães.
  for (const n of visible) {
    const mother = n.hierarchyMotherId
    if (!mother || visibleIds.has(mother) || placed.has(mother)) continue
    roots.push(
      build(mother, null, titleOf.get(mother) ?? n.hierarchyMotherTitle ?? 'Mãe encerrada'),
    )
  }
  // Ciclo (A filha de B e B de A): ninguém é raiz; entra como raiz pra não sumir.
  for (const n of visible) if (!placed.has(n.sessionId)) roots.push(build(n.sessionId, n, n.title))
  return roots
}

// Com o grupo recolhido, só ficam à vista as filhas que precisam de você (ou que
// têm alguém abaixo delas precisando).
export function visibleChildren(item: SessionTreeItem, expanded: boolean): SessionTreeItem[] {
  if (expanded) return item.children
  return item.children.filter((c) => c.needsYou || c.descendantsNeedingYou > 0)
}

export function childrenSummary(item: SessionTreeItem): string {
  const n = item.descendants
  const label = `${n} ${n === 1 ? 'filha' : 'filhas'}`
  const m = item.descendantsNeedingYou
  return m > 0 ? `${label} · ${m} ${m === 1 ? 'precisa' : 'precisam'} de você` : label
}
