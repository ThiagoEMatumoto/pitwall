// PURO: o que a Room da feature mostra. Nenhuma regra de atenção própria — a fila
// é o recorte da projeção do main pelo mesmo predicado do card do Ctrl+`.
import { motherOfFocus } from '../session-canvas/mother-dock'
import {
  attentionSubjectKey,
  humanQueue,
  itemsForFeature,
} from '../../../shared/attention/selectors'
import { PRODUCED_ATTENTION_KINDS, type AttentionItem } from '../../../shared/types/attention'
import type { RoomTimelineEvent } from '../../../shared/types/feature-room'
import type { Handoff, HandoffStatus, LiveSessionInfo } from '../../../shared/types/ipc'
import type {
  SessionGraph,
  SessionGraphNode,
  SessionGraphStatus,
} from '../../../shared/types/session-graph'
import { stripUnsafeDisplay } from '../../../shared/tui/permission-request'
import { HIDDEN_TIMELINE_EVENTS } from './room-labels'

export interface RoomViewInput {
  featureId: string
  graph: SessionGraph
  handoffs: Handoff[]
  live: LiveSessionInfo[]
  attention: AttentionItem[] // attention:list inteiro
  // EXATAMENTE o do Ctrl+` (switcherInUse): com outro inUse o N divergiria.
  inUse: ReadonlySet<string>
  timeline: RoomTimelineEvent[]
  timelineFilter: string | null // sessionId
}

export interface RoomQueueRow {
  subjectKey: string
  head: AttentionItem
  also: AttentionItem[]
}

export type WorkPill = { status: HandoffStatus; resumable: boolean; resultUnread: boolean } | null
export type ExecState = SessionGraphStatus | 'gone' // 'gone' = sem nó no grafo (PTY morta)

export interface RoomSessionRow {
  sessionId: string | null
  handoffId: string | null
  title: string
  repoLabel: string
  depth: 0 | 1 | 2 // 0 mãe, 1 filha, 2 neta
  work: WorkPill
  exec: ExecState
  lastText: string | null
  purpose: string | null
}

export interface RoomRepo {
  repoId: string | null
  label: string
  rows: RoomSessionRow[]
}

export interface RoomProgress {
  total: number
  done: number
  running: number
  needsYou: number
  stopped: number
}

export type RoomState = 'empty' | 'solo' | 'green' | 'normal'

export interface RoomView {
  queue: RoomQueueRow[]
  needsYou: number // === queue.length
  mother: RoomSessionRow | null
  progress: RoomProgress
  repos: RoomRepo[]
  timeline: RoomTimelineEvent[]
  state: RoomState
}

const PRODUCED: ReadonlySet<string> = new Set(PRODUCED_ATTENTION_KINDS)
const RUNNING: ReadonlySet<HandoffStatus> = new Set(['pending', 'approved', 'running'])
const STOPPED: ReadonlySet<HandoffStatus> = new Set(['failed', 'interrupted'])

// 1 linha por sujeito, na ordem da projeção (o 1º item do sujeito é o mais grave).
function groupBySubject(items: AttentionItem[]): RoomQueueRow[] {
  const rows = new Map<string, RoomQueueRow>()
  for (const item of items) {
    const key = attentionSubjectKey(item)
    const row = rows.get(key)
    if (row) row.also.push(item)
    else rows.set(key, { subjectKey: key, head: item, also: [] })
  }
  return [...rows.values()]
}

function nodeTitle(n: SessionGraphNode): string {
  return stripUnsafeDisplay(n.cliName ?? n.title)
}

// Tela/transcript e texto de agente (task, purpose, detail) não são confiáveis: um
// U+202E ou ANSI disfarçaria o que a Room mostra ao lado de um botão de resposta.
const safe = (t: string | null | undefined): string | null =>
  t == null ? null : stripUnsafeDisplay(t)

export function buildRoomView(input: RoomViewInput): RoomView {
  const { featureId, graph, inUse } = input
  const byId = new Map(graph.nodes.map((n) => [n.sessionId, n]))
  const lastTextOf = new Map(input.live.map((l) => [l.id, safe(l.lastText)]))
  const lane = graph.lanes.find((l) => l.kind === 'feature' && l.featureId === featureId)
  const laneNodes = (lane?.repos ?? [])
    .flatMap((r) => r.sessionIds)
    .map((id) => byId.get(id))
    .filter((n): n is SessionGraphNode => !!n && inUse.has(n.sessionId))
  const laneSessionIds = new Set(laneNodes.map((n) => n.sessionId))

  const items = itemsForFeature(humanQueue(input.attention), laneSessionIds, inUse, featureId)
  const queue = groupBySubject(items.filter((i) => PRODUCED.has(i.kind)))

  const handoffs = input.handoffs.filter((h) => h.featureId === featureId && h.dismissedAt == null)
  // Sessão única que ainda não delegou: é a mãe da feature (estado "1 sessão só"),
  // mesmo sem isMother no grafo.
  const motherId =
    motherOfFocus(laneNodes, graph.edges, inUse, { featureId }) ??
    (laneNodes.length === 1 && handoffs.length === 0 ? laneNodes[0].sessionId : null)
  const motherNode = motherId ? byId.get(motherId) : undefined
  const mother: RoomSessionRow | null = motherNode
    ? {
        sessionId: motherNode.sessionId,
        handoffId: motherNode.childOfHandoffId,
        title: nodeTitle(motherNode),
        repoLabel: motherNode.repoLabel ?? '',
        depth: 0,
        work: null,
        exec: motherNode.status,
        lastText: lastTextOf.get(motherNode.sessionId) ?? null,
        purpose: safe(motherNode.purpose),
      }
    : null

  const childIds = new Set(handoffs.flatMap((h) => (h.childSessionId ? [h.childSessionId] : [])))
  const handoffRow = (h: Handoff): RoomSessionRow & { repoId: string | null } => {
    const node = h.childSessionId ? byId.get(h.childSessionId) : undefined
    return {
      sessionId: h.childSessionId,
      handoffId: h.id,
      title: node ? nodeTitle(node) : stripUnsafeDisplay(h.task),
      repoId: node?.repoId ?? h.targetRepoId,
      repoLabel: node?.repoLabel ?? h.targetRepoLabel ?? '',
      // Neta: a mãe dela é filha de outro handoff desta feature.
      depth: h.motherSessionId && childIds.has(h.motherSessionId) ? 2 : 1,
      work: {
        status: h.status,
        resumable: h.resumable,
        resultUnread: h.status === 'done' && h.consumedAt == null,
      },
      exec: node ? node.status : 'gone',
      lastText: h.childSessionId ? (lastTextOf.get(h.childSessionId) ?? null) : null,
      purpose: safe(node?.purpose ?? h.task),
    }
  }
  const handoffRows = handoffs.filter((h) => h.childSessionId !== motherId).map(handoffRow)
  // Sessões da lane sem handoff (nem mãe): filhas "soltas" na feature.
  const looseRows = laneNodes
    .filter((n) => n.sessionId !== motherId && !childIds.has(n.sessionId))
    .map((n): RoomSessionRow & { repoId: string | null } => ({
      sessionId: n.sessionId,
      handoffId: null,
      title: nodeTitle(n),
      repoId: n.repoId,
      repoLabel: n.repoLabel ?? '',
      depth: 1,
      work: null,
      exec: n.status,
      lastText: lastTextOf.get(n.sessionId) ?? null,
      purpose: safe(n.purpose),
    }))

  const repos = groupByRepo(handoffRows, looseRows, handoffs)
  const queuedHandoffs = new Set(queue.flatMap((r) => [r.head, ...r.also]).map((i) => i.handoffId))
  const progress: RoomProgress = {
    total: handoffs.length,
    done: handoffs.filter((h) => h.status === 'done').length,
    running: handoffs.filter((h) => RUNNING.has(h.status)).length,
    needsYou: handoffs.filter((h) => queuedHandoffs.has(h.id)).length,
    stopped: handoffs.filter((h) => STOPPED.has(h.status) && !queuedHandoffs.has(h.id)).length,
  }

  const f = input.timelineFilter
  const timeline = input.timeline
    .filter(
      (e) =>
        !HIDDEN_TIMELINE_EVENTS.has(e.event) &&
        (f == null || e.childSessionId === f || e.motherSessionId === f),
    )
    .map((e) => ({ ...e, task: stripUnsafeDisplay(e.task), detail: safe(e.detail) }))

  const state: RoomState =
    laneNodes.length === 0 && handoffs.length === 0
      ? 'empty'
      : laneNodes.length === 1 && handoffs.length === 0
        ? 'solo'
        : queue.length === 0
          ? 'green'
          : 'normal'

  return { queue, needsYou: queue.length, mother, progress, repos, timeline, state }
}

// Filhas agrupadas pelo repo; cada neta vai logo abaixo da filha-mãe dela, na sala
// da filha (o recuo é o que mostra a relação).
function groupByRepo(
  handoffRows: Array<RoomSessionRow & { repoId: string | null }>,
  looseRows: Array<RoomSessionRow & { repoId: string | null }>,
  handoffs: Handoff[],
): RoomRepo[] {
  const motherOfRow = new Map(handoffs.map((h) => [h.id, h.motherSessionId]))
  const grandkids = handoffRows.filter((r) => r.depth === 2)
  const repos = new Map<string, RoomRepo>()
  const place = (row: RoomSessionRow & { repoId: string | null }) => {
    const key = row.repoId ?? `label:${row.repoLabel}`
    const repo = repos.get(key) ?? { repoId: row.repoId, label: row.repoLabel, rows: [] }
    repos.set(key, repo)
    const { repoId: _repoId, ...plain } = row
    repo.rows.push(plain)
    return repo
  }
  for (const row of [...handoffRows.filter((r) => r.depth === 1), ...looseRows]) {
    const repo = place(row)
    for (const g of grandkids) {
      if (row.sessionId && motherOfRow.get(g.handoffId ?? '') === row.sessionId) {
        const { repoId: _repoId, ...plain } = g
        repo.rows.push(plain)
      }
    }
  }
  // Neta cuja filha-mãe não virou linha (dispensada): sobe para a sala dela.
  const placed = new Set([...repos.values()].flatMap((r) => r.rows.map((x) => x.handoffId)))
  for (const g of grandkids) if (!placed.has(g.handoffId)) place(g)
  return [...repos.values()]
}
