// PURO: o que o seletor rápido de features (Ctrl+`) mostra e como ele cicla.
import { indicatorFor, type IndicatorTone } from './card-indicator'
import { featureLaneId, projectLaneId } from './graph-to-flow'
import { motherOfFocus } from './mother-dock'
import type { LiveSessionInfo } from '../../../shared/types/ipc'
import type { SessionGraph } from '../../../shared/types/session-graph'

export interface SwitcherEntry {
  // Chave do MRU: o featureId, ou `p:<projeto>` para o grupo "Sem feature".
  key: string
  kind: 'feature' | 'project'
  featureId: string | null
  laneFlowId: string
  title: string
  pulse: string | null
  motherId: string | null
  motherTitle: string | null
  motherTone: IndicatorTone | null
  working: number
  needsYou: number
  // Projetos que o card toca (home + repos): no escopo de um deles o mapa o mostra.
  projectIds: string[]
}

export const projectKey = (projectId: string | null) => `p:${projectId ?? 'loose'}`
export const isProjectKey = (key: string) => key.startsWith('p:')

type LiveBits = Pick<LiveSessionInfo, 'attentionReason' | 'lastText'>

// tailOf: as últimas linhas da tela de cada sessão (card-view-store), para o tom
// bater com o do mapa e dos contadores (interrompida ≠ precisa de você).
export function buildSwitcherEntries(
  graph: SessionGraph,
  live: ReadonlyMap<string, LiveBits>,
  tailOf: (sessionId: string) => string[] | null = () => null,
): SwitcherEntry[] {
  const byId = new Map(graph.nodes.map((n) => [n.sessionId, n]))
  const inUse = new Set(graph.nodes.filter((n) => n.status !== 'ended').map((n) => n.sessionId))
  return graph.lanes.map((lane) => {
    const nodes = lane.repos
      .flatMap((r) => r.sessionIds)
      .map((id) => byId.get(id))
      .filter((n): n is NonNullable<typeof n> => !!n && inUse.has(n.sessionId))
    const tones = new Map(
      nodes.map((n) => [
        n.sessionId,
        indicatorFor(n, live.get(n.sessionId), null, tailOf(n.sessionId)).tone,
      ]),
    )
    const count = (pred: (t: IndicatorTone) => boolean) => [...tones.values()].filter(pred).length
    // Só as sessões do cartão entram: o fallback de motherOfFocus ("a mais recente
    // do mapa") não pode emprestar a mãe de outra feature.
    const motherId = motherOfFocus(nodes, graph.edges, inUse, {
      featureId: lane.kind === 'feature' ? lane.featureId : null,
    })
    const mother = motherId ? byId.get(motherId) : undefined
    const base = {
      motherId: motherId ?? null,
      motherTitle: mother ? (mother.cliName ?? mother.title) : null,
      motherTone: motherId ? (tones.get(motherId) ?? null) : null,
      working: count((t) => t === 'working' || t === 'starting'),
      needsYou: count((t) => t === 'needs-you'),
    }
    if (lane.kind === 'feature') {
      const projectIds = [lane.projectId, ...lane.repos.map((r) => r.projectId)]
      return {
        projectIds: [...new Set(projectIds.filter((p): p is string => !!p))],
        key: lane.featureId,
        kind: 'feature',
        featureId: lane.featureId,
        laneFlowId: featureLaneId(lane.featureId),
        title: lane.name,
        pulse: lane.pulse,
        ...base,
      }
    }
    return {
      key: projectKey(lane.projectId),
      kind: 'project',
      featureId: null,
      laneFlowId: projectLaneId(lane.projectId),
      title: `Sem feature · ${lane.name}`,
      projectIds: lane.projectId ? [lane.projectId] : [],
      pulse: null,
      ...base,
    }
  })
}

// Ao abrir, o destino já é a anterior (a 2ª da lista): um toque rápido alterna
// entre as duas últimas, como o Alt+Tab. Shift abre pela última da lista. Sem a
// atual no topo (nada em foco, como logo depois do boot) a 1ª já é a anterior.
export function openIndex(size: number, backward: boolean, hasCurrent = true): number {
  if (size === 0) return -1
  if (backward) return size - 1
  return hasCurrent && size > 1 ? 1 : 0
}

export function stepIndex(index: number, dir: 1 | -1, size: number): number {
  if (size === 0) return -1
  return (index + dir + size) % size
}

// O mapa no escopo de um projeto (scopeProjectId) não mostra este card: confirmar
// nele precisa abrir o escopo, senão não há o que enquadrar.
export function leavesScope(entry: SwitcherEntry, scopeProjectId: string | null): boolean {
  return !!scopeProjectId && !entry.projectIds.includes(scopeProjectId)
}

// O grupo "Sem feature" de uma sessão: o da lane em que o grafo a pôs (sem repo
// ela vai para as avulsas mesmo tendo projeto). Sessão de feature: null.
export function groupKeyOf(graph: SessionGraph, sessionId: string): string | null {
  const lane = graph.lanes.find(
    (l) => l.kind === 'project' && l.repos.some((r) => r.sessionIds.includes(sessionId)),
  )
  return lane?.kind === 'project' ? projectKey(lane.projectId) : null
}
