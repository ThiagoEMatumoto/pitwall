import type { SessionGraphNode } from '../../../shared/types/session-graph'

// Régua ÚNICA de "é filha de quem" no renderer. Vem do grafo (hierarchyMotherId,
// readHierarchyLinks no main), casada pela CONVERSA: filha retomada (linha nova),
// com handoff done/dispensado ou com a mãe retomada continua filha. Só o
// Desvincular (release) a solta. As arestas 'handoff' do grafo saem da mesma régua.
export function motherOfChildMap(
  nodes: ReadonlyArray<Pick<SessionGraphNode, 'sessionId' | 'hierarchyMotherId'>>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const n of nodes) {
    const mother = n.hierarchyMotherId
    if (mother && mother !== n.sessionId) out.set(n.sessionId, mother)
  }
  return out
}

// Handoff do vínculo por sessão (a conversa, não o id exato do child_session_id).
export function hierarchyHandoffMap(
  nodes: ReadonlyArray<Pick<SessionGraphNode, 'sessionId' | 'hierarchyHandoffId'>>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const n of nodes) if (n.hierarchyHandoffId) out.set(n.sessionId, n.hierarchyHandoffId)
  return out
}

// Superfícies de MÃE (Room, Dock, Ctrl+Shift+O, filtro): lidera filhas OU o humano
// marcou "essa é a mãe", ou tem filha pelo fio (hierarchyChildCount: filha done ou
// dispensada continua filha). isMother sozinho segue sendo "lidera filhas" (badge, bastão).
export function isMotherLike(
  n: Pick<SessionGraphNode, 'isMother' | 'isPinnedMother' | 'hierarchyChildCount'>,
): boolean {
  return n.isMother === true || n.isPinnedMother === true || (n.hierarchyChildCount ?? 0) > 0
}

export interface NestedItem<T> {
  item: T
  // 0 = topo; 1+ = filha (neta…) logo abaixo da mãe.
  depth: number
  motherId: string | null
}

// Filha logo abaixo da mãe (recursivo), mantendo a ordem das raízes. Filha cuja
// mãe não está na lista fica onde estava, como raiz: esconder a deixaria sem
// caminho nenhum. Ciclo (dado sujo) também cai como raiz.
export function nestUnderMothers<T extends { id: string }>(
  items: readonly T[],
  motherOfChild: ReadonlyMap<string, string>,
): NestedItem<T>[] {
  const present = new Set(items.map((s) => s.id))
  const kidsOf = new Map<string, T[]>()
  for (const s of items) {
    const m = motherOfChild.get(s.id)
    if (m && m !== s.id && present.has(m)) kidsOf.set(m, [...(kidsOf.get(m) ?? []), s])
  }
  const out: NestedItem<T>[] = []
  const placed = new Set<string>()
  const place = (s: T, depth: number, motherId: string | null) => {
    if (placed.has(s.id)) return
    placed.add(s.id)
    out.push({ item: s, depth, motherId })
    for (const k of kidsOf.get(s.id) ?? []) place(k, depth + 1, s.id)
  }
  const isNestedChild = (s: T) => {
    const m = motherOfChild.get(s.id)
    return !!m && m !== s.id && present.has(m)
  }
  for (const s of items) if (!isNestedChild(s)) place(s, 0, null)
  for (const s of items) place(s, 0, null)
  return out
}

// Seção "Mães" no início: as raízes fixadas como mãe sobem com a subárvore, na
// ordem em que foram fixadas (pinOrder = sessions.id na ordem do pin).
export function pinnedMothersFirst<T extends { id: string }>(
  nested: NestedItem<T>[],
  pinOrder: readonly string[],
): { pinned: NestedItem<T>[]; rest: NestedItem<T>[] } {
  const rank = new Map(pinOrder.map((id, i) => [id, i]))
  const groups: NestedItem<T>[][] = []
  for (const n of nested) {
    if (n.depth === 0) groups.push([n])
    else groups[groups.length - 1]?.push(n)
  }
  const isPinned = (g: NestedItem<T>[]) => rank.has(g[0].item.id)
  return {
    pinned: groups
      .filter(isPinned)
      .sort((a, b) => rank.get(a[0].item.id)! - rank.get(b[0].item.id)!)
      .flat(),
    rest: groups.filter((g) => !isPinned(g)).flat(),
  }
}

// Status de agrupamento: a filha herda o da raiz da sua árvore (se a raiz está na
// lista), para as listas agrupadas por status não separarem mãe e filha.
export function groupStatusUnderMother<T extends { id: string; status: string }>(
  items: readonly T[],
  motherOfChild: ReadonlyMap<string, string>,
): Map<string, T['status']> {
  const byId = new Map(items.map((s) => [s.id, s]))
  const out = new Map<string, T['status']>()
  for (const s of items) {
    let root = s
    const seen = new Set([s.id])
    for (
      let m = motherOfChild.get(root.id);
      m && byId.has(m) && !seen.has(m);
      m = motherOfChild.get(root.id)
    ) {
      seen.add(m)
      root = byId.get(m)!
    }
    out.set(s.id, root.status)
  }
  return out
}
