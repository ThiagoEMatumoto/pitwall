// PURO: o que o seletor rápido de features (Ctrl+`) mostra e como ele cicla.
import { indicatorFor, type IndicatorTone } from './card-indicator'
import { featureLaneId, projectLaneId } from './graph-to-flow'
import { motherOfFocus } from './mother-dock'
import { formatCombo, type Combo } from '../../lib/keybindings'
import type { LiveSessionInfo } from '../../../shared/types/ipc'
import type { SessionGraph } from '../../../shared/types/session-graph'
import { attentionSubjectKey, humanQueue } from '../../../shared/attention/selectors'
import type { AttentionItem } from '../../../shared/types/attention'

export interface SwitcherEntry {
  // Chave do MRU: o featureId, ou `p:<projeto>` para o grupo "Sem feature".
  key: string
  // 'attention': itens da fila sem card no mapa (filha interrompida sem sessão
  // desenhada, feature sem lane). Sem ele o HUD contaria e o seletor não.
  kind: 'feature' | 'project' | 'attention'
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
  // Só no 'attention': o que confirmar abre (quick look da filha, senão o mapa).
  handoffId?: string | null
  sessionId?: string | null
}

export const projectKey = (projectId: string | null) => `p:${projectId ?? 'loose'}`
export const isProjectKey = (key: string) => key.startsWith('p:')
export const attentionKey = (featureId: string | null) => `a:${featureId ?? 'loose'}`

type LiveBits = Pick<LiveSessionInfo, 'attentionReason' | 'lastText'>

// tailOf: as últimas linhas da tela de cada sessão (card-view-store), para o tom
// bater com o do mapa e dos contadores (interrompida ≠ precisa de você).
// inUse: as sessões que o mapa desenha (mapSessionIds). Card sem nenhuma delas
// não está no mapa e não entra: confirmar nele não teria o que enquadrar.
// attention: a fila única (attention:list). needsYou é o recorte dela por card —
// o mesmo número que o HUD soma, nunca uma regra própria pelo tom.
export function buildSwitcherEntries(
  graph: SessionGraph,
  live: ReadonlyMap<string, LiveBits>,
  tailOf: (sessionId: string) => string[] | null = () => null,
  inUse: ReadonlySet<string> = new Set(
    graph.nodes.filter((n) => n.status !== 'ended').map((n) => n.sessionId),
  ),
  attention: AttentionItem[] = [],
  featureTitleOf: (featureId: string) => string | null = () => null,
): SwitcherEntry[] {
  const byId = new Map(graph.nodes.map((n) => [n.sessionId, n]))
  const queue = humanQueue(attention)
  // Sujeitos já contados por algum card: o resto vira card de atenção, para a
  // soma do seletor ser sempre o length da projeção (o número do HUD).
  const claimed = new Set<string>()
  const laneEntries = graph.lanes.flatMap((lane): SwitcherEntry[] => {
    const nodes = lane.repos
      .flatMap((r) => r.sessionIds)
      .map((id) => byId.get(id))
      .filter((n): n is NonNullable<typeof n> => !!n && inUse.has(n.sessionId))
    if (nodes.length === 0) return []
    const tones = new Map(
      nodes.map((n) => [
        n.sessionId,
        indicatorFor(n, live.get(n.sessionId), null, tailOf(n.sessionId)).tone,
      ]),
    )
    const count = (pred: (t: IndicatorTone) => boolean) => [...tones.values()].filter(pred).length
    const laneFeature = lane.kind === 'feature' ? lane.featureId : null
    const laneSessions = new Set(nodes.map((n) => n.sessionId))
    // Item cuja sessão o mapa não desenha (filha interrompida, sem PTY) pertence
    // ao card pela feature.
    const subjects = new Set(
      queue
        .filter((i) =>
          i.sessionId && inUse.has(i.sessionId)
            ? laneSessions.has(i.sessionId)
            : laneFeature != null && i.featureId === laneFeature,
        )
        .map(attentionSubjectKey),
    )
    for (const k of subjects) claimed.add(k)
    // Só as sessões do cartão entram: o fallback de motherOfFocus ("a mais recente
    // do mapa") não pode emprestar a mãe de outra feature.
    const motherId = motherOfFocus(nodes, graph.edges, inUse, { featureId: laneFeature })
    const mother = motherId ? byId.get(motherId) : undefined
    const base = {
      motherId: motherId ?? null,
      motherTitle: mother ? (mother.cliName ?? mother.title) : null,
      motherTone: motherId ? (tones.get(motherId) ?? null) : null,
      working: count((t) => t === 'working' || t === 'starting'),
      needsYou: subjects.size,
    }
    if (lane.kind === 'feature') {
      const projectIds = [lane.projectId, ...lane.repos.map((r) => r.projectId)]
      return [
        {
          projectIds: [...new Set(projectIds.filter((p): p is string => !!p))],
          key: lane.featureId,
          kind: 'feature',
          featureId: lane.featureId,
          laneFlowId: featureLaneId(lane.featureId),
          title: lane.name,
          pulse: lane.pulse,
          ...base,
        },
      ]
    }
    return [
      {
        key: projectKey(lane.projectId),
        kind: 'project',
        featureId: null,
        laneFlowId: projectLaneId(lane.projectId),
        title: `Sem feature · ${lane.name}`,
        projectIds: lane.projectId ? [lane.projectId] : [],
        pulse: null,
        ...base,
      },
    ]
  })
  return [...orphanEntries(queue, claimed, featureTitleOf), ...laneEntries]
}

// Um card por feature (ou "loose") para os itens que nenhum card do mapa contou.
// Vêm primeiro: são exatamente os que o mapa não mostra.
function orphanEntries(
  queue: AttentionItem[],
  claimed: ReadonlySet<string>,
  featureTitleOf: (featureId: string) => string | null,
): SwitcherEntry[] {
  const groups = new Map<string, AttentionItem[]>()
  for (const i of queue) {
    if (claimed.has(attentionSubjectKey(i))) continue
    const key = attentionKey(i.featureId)
    groups.set(key, [...(groups.get(key) ?? []), i])
  }
  return [...groups].map(([key, items]) => {
    const first = items[0]
    const featureId = first.featureId
    const title = featureId
      ? `${featureTitleOf(featureId) ?? 'Feature'} · fora do mapa`
      : 'Precisa de você · fora do mapa'
    return {
      key,
      kind: 'attention',
      featureId,
      laneFlowId: featureId ? featureLaneId(featureId) : '',
      title,
      pulse: first.whyNow,
      motherId: null,
      motherTitle: null,
      motherTone: null,
      working: 0,
      needsYou: new Set(items.map(attentionSubjectKey)).size,
      projectIds: [],
      handoffId: items.find((i) => i.handoffId)?.handoffId ?? null,
      sessionId: items.find((i) => i.sessionId)?.sessionId ?? null,
    }
  })
}

// A tecla do atalho na dica: o atalho se chama Ctrl+` (a tecla acima do Tab).
// Casa pela tecla FÍSICA (matchCombo usa e.code), e no ABNT2 essa tecla é a do
// ' — o ` de lá (Shift+´) não dispara nada. Por isso a crase vem com a nota da
// tecla física quando o layout a rotula diferente (switcherKeyNote).
export function switcherKeyLabel(combo: Combo): string {
  if (combo.code === 'Backquote') return '`'
  return formatCombo({ code: combo.code, key: combo.key })
}

export function switcherKeyNote(combo: Combo): string | null {
  if (combo.code !== 'Backquote') return null
  const physical = formatCombo({ code: combo.code })
  return physical === '`' ? null : `tecla ${physical}`
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
export function leavesScope(
  entry: Pick<SwitcherEntry, 'projectIds'>,
  scopeProjectId: string | null,
): boolean {
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
