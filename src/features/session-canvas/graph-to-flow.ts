// PURO: grafo de sessões + estado do canvas → nós/arestas do @xyflow/react.
//
// Hierarquia: lane de projeto → lane de repo → cartão de sessão (parentId,
// posições relativas ao pai). Sessão num grupo do usuário sai da lane e vira
// filha do grupo. Notas ficam na raiz: soltas numa faixa acima das lanes, presas
// numa calha à direita da lane da sessão. Sem posição salva, cada peça cai num
// slot determinístico (é o mesmo layout que o Organizar grava — tidy.ts).
import type { Edge, Node } from '@xyflow/react'
import type {
  SessionGraph,
  SessionGraphAttention,
  SessionGraphEdge,
  SessionGraphNode,
} from '../../../shared/types/session-graph'
import type {
  CardViewState,
  CanvasEntityKind,
  CanvasNote,
  CanvasPosition,
  CanvasScope,
  SessionGroup,
} from '../../../shared/types/canvas'
import { GLOBAL_CANVAS_SCOPE } from '../../../shared/types/canvas'
import { viewOf, type ViewMap } from './card-view'

// Cartão recolhido (identidade + estado). Aberto e terminal crescem: a saída ao
// vivo precisa de ~55 colunas legíveis, e o terminal de um xterm de verdade.
// Recolhido é UMA linha (ponto + alias + motivo); aberto é a vaga máxima — o
// cartão desenhado só ocupa o que tem (saída ao vivo sem caixa vazia).
export const CARD_W = 248
export const CARD_H = 40
export const OPEN_W = 400
export const OPEN_H = 300
export const TERMINAL_W = 780
export const TERMINAL_H = 540
export const NOTE_W = 220
export const NOTE_H = 132
const GAP = 16
const PAD = 12
const HEADER = 30
const LANE_GAP = 48
const GROUP_MIN_W = CARD_W + 2 * PAD
const GROUP_MIN_H = HEADER + 72
// Camadas (zIndexMode 'manual' no SessionMap: o z de cada nó/fio é exatamente o
// daqui). No 'basic' o fio somava o z do cartão que toca, e selecionar um cartão
// (+1000) levava os fios dele POR CIMA de todos os outros cartões, inclusive do
// xterm em uso. Lanes 0/1 (o xyflow põe filho = pai + 1), repoDep 2 (acima do
// fundo das lanes), fios 3, cartões e notas 5.
export const CARD_Z = 5
export const EDGE_Z = 3
const REPO_DEP_EDGE_Z = 2

export interface MapInput {
  graph: SessionGraph
  scope: CanvasScope
  positions: CanvasPosition[]
  notes: CanvasNote[]
  groups: SessionGroup[]
  // Sessões em uso (sessions.id): o MESMO conjunto que a área Projetos já mostra
  // (mapSessionIds, em useGlobalSessions). Encerrada some do mapa — o grafo do
  // main ainda as traz (mãe/antecessora de handoff), mas só como contexto.
  // Ausente = a vivacidade do próprio grafo (status !== 'ended').
  inUse?: ReadonlySet<string>
  // Mães com o leque de filhas aberto (sessionId). Sem isto, mãe com mais de
  // FAN_COLLAPSE_AT filhas só mostra os fios dela no foco.
  expandedMothers?: ReadonlySet<string>
  // Estado de exibição de cada cartão (ausente = 'open') e o tamanho do terminal.
  views?: ViewMap
  terminalSizes?: Readonly<Record<string, { w: number; h: number }>>
}

export function cardSize(view: CardViewState, terminal?: { w: number; h: number }): Size {
  if (view === 'collapsed') return { w: CARD_W, h: CARD_H }
  if (view === 'open') return { w: OPEN_W, h: OPEN_H }
  return terminal ?? { w: TERMINAL_W, h: TERMINAL_H }
}

// Acima disto o mapa fica em "modo cheio": fios repoDep/feature só aparecem ao
// selecionar/passar o mouse num cartão, e os rótulos dos fios também.
export const EDGE_BUSY_THRESHOLD = 8
// Acima disto o leque mãe→filhas cruzava o mapa inteiro: os fios recolhem.
export const FAN_COLLAPSE_AT = 3

export interface SessionCardData {
  node: SessionGraphNode
  childCount: number
  summaryStale: boolean
  attentionLabel: string | null
  // Herdou o bastão de uma sessão que já encerrou: o título dela (sem nó nem fio).
  continuesFrom: string | null
  // Filha de handoff: a mãe (alias) e se ela está no mapa (o chip "↳ de" vira
  // atalho até ela); mãe encerrada fica só como texto.
  motherOf: { sessionId: string; title: string; onMap: boolean } | null
  // 1ª linha da nota presa a esta sessão (a mais recente), se houver.
  noteExcerpt: string | null
  // Mãe com o leque recolhido (mais de FAN_COLLAPSE_AT filhas) e se está aberto.
  fanCollapsible: boolean
  fanExpanded: boolean
  view: CardViewState
  [key: string]: unknown
}

export interface LaneData {
  level: 'project' | 'repo'
  label: string
  color: string | null
  projectId: string | null
  repoId: string | null
  // Só na lane de projeto: quantas sessões dela pedem você agora.
  attentionCount?: number
  [key: string]: unknown
}

export interface UserGroupData {
  group: SessionGroup
  memberCount: number
  [key: string]: unknown
}

export interface NoteData {
  note: CanvasNote
  // Presa a uma sessão que encerrou: fica solta, com a marca "sessão encerrada".
  sessionEnded?: boolean
  [key: string]: unknown
}

export type MapEdgeKind = 'handoff' | 'baton' | 'repoDep' | 'feature' | 'note'

export interface MapEdgeData {
  kind: MapEdgeKind
  live: boolean
  alert: boolean
  label: string | null
  handoffId: string | null
  // repoDep/feature com o mapa cheio: escondidas até um cartão ligado entrar em foco.
  aggregate?: boolean
  // Mapa cheio: o rótulo só aparece com o fio em foco (alerta sempre aparece).
  busy?: boolean
  // Fio de uma mãe com o leque recolhido: só aparece no foco (alerta sempre).
  fanned?: boolean
  [key: string]: unknown
}

export type MapNode = Node<SessionCardData | LaneData | UserGroupData | NoteData>
export type MapEdge = Edge<MapEdgeData>

export const sessionNodeId = (id: string) => `s:${id}`
export const repoLaneId = (repoId: string | null) => `lane:r:${repoId ?? 'loose'}`
export const projectLaneId = (projectId: string | null) => `lane:p:${projectId ?? 'loose'}`
export const groupNodeId = (id: string) => `g:${id}`
export const noteNodeId = (id: string) => `n:${id}`

// Chave de canvas_positions de cada nó que o usuário pode mover. Lanes de repo
// não: elas se arrumam sozinhas dentro da lane do projeto.
export function positionKey(flowId: string): { kind: CanvasEntityKind; entityId: string } | null {
  if (flowId.startsWith('s:')) return { kind: 'session', entityId: flowId.slice(2) }
  if (flowId.startsWith('n:')) return { kind: 'note', entityId: flowId.slice(2) }
  if (flowId.startsWith('g:')) return { kind: 'group', entityId: flowId.slice(2) }
  if (flowId.startsWith('lane:p:')) return { kind: 'lane', entityId: flowId.slice(5) }
  return null
}

const ATTENTION_LABEL: Record<SessionGraphAttention, string> = {
  'handoff-input': 'a filha perguntou',
  waiting: 'esperando você',
}

interface Point {
  x: number
  y: number
}

interface Size {
  w: number
  h: number
}

interface Box extends Point, Size {}

type SavedIndex = Map<string, CanvasPosition>

function savedIndex(positions: CanvasPosition[]): SavedIndex {
  return new Map(positions.map((p) => [`${p.kind}:${p.entityId}`, p]))
}

// Filhos de um contêiner: os salvos ficam onde o usuário deixou; os novos
// empilham numa coluna abaixo do mais baixo deles (nunca por cima).
function stackChildren(
  ids: string[],
  saved: (id: string) => Point | undefined,
  heightOf: (id: string) => number,
): Map<string, Point> {
  const out = new Map<string, Point>()
  let cursor = HEADER
  for (const id of ids) {
    const p = saved(id)
    if (p) {
      out.set(id, { x: p.x, y: p.y })
      cursor = Math.max(cursor, p.y + heightOf(id) + GAP)
    }
  }
  for (const id of ids) {
    if (out.has(id)) continue
    out.set(id, { x: PAD, y: cursor })
    cursor += heightOf(id) + GAP
  }
  return out
}

function fit(children: Map<string, Point>, sizeOf: (id: string) => Size, min: Size) {
  let w = min.w
  let h = min.h
  for (const [id, p] of children) {
    w = Math.max(w, p.x + sizeOf(id).w + PAD)
    h = Math.max(h, p.y + sizeOf(id).h + PAD)
  }
  return { w, h }
}

export function lastSeenAt(n: SessionGraphNode): number {
  return n.endedAt ?? n.lastActivityAt ?? n.startedAt ?? 0
}

function inUseIds(input: MapInput): Set<string> {
  return new Set(
    input.graph.nodes
      .filter((n) => (input.inUse ? input.inUse.has(n.sessionId) : n.status !== 'ended'))
      .map((n) => n.sessionId),
  )
}

function scopedSessions(input: MapInput, inUse: Set<string>): SessionGraphNode[] {
  return input.graph.nodes.filter(
    (n) =>
      inUse.has(n.sessionId) && (input.scope === GLOBAL_CANVAS_SCOPE || n.projectId === input.scope),
  )
}

// Bastão cuja antecessora encerrou: a sucessora diz de quem continua, em texto.
function continuations(graph: SessionGraph, inUse: Set<string>): Map<string, string> {
  const byId = new Map(graph.nodes.map((n) => [n.sessionId, n]))
  const out = new Map<string, string>()
  for (const e of graph.edges) {
    if (e.kind !== 'baton' || inUse.has(e.from) || !inUse.has(e.to)) continue
    const pred = byId.get(e.from)
    if (pred) out.set(e.to, pred.title)
  }
  return out
}

// Filha → mãe, pelos fios de handoff do grafo (a mãe pode já ter encerrado).
function mothersOf(
  graph: SessionGraph,
  inUse: Set<string>,
): Map<string, { sessionId: string; title: string; onMap: boolean }> {
  const byId = new Map(graph.nodes.map((n) => [n.sessionId, n]))
  const out = new Map<string, { sessionId: string; title: string; onMap: boolean }>()
  for (const e of graph.edges) {
    if (e.kind !== 'handoff' || !inUse.has(e.to)) continue
    const mother = byId.get(e.from)
    if (mother) out.set(e.to, { sessionId: e.from, title: mother.title, onMap: inUse.has(e.from) })
  }
  return out
}

// Quem pede você primeiro, depois a atividade mais recente.
export function sortForLane(sessions: SessionGraphNode[]): SessionGraphNode[] {
  return [...sessions].sort(
    (a, b) =>
      Number(!!b.attentionReason) - Number(!!a.attentionReason) || lastSeenAt(b) - lastSeenAt(a),
  )
}


// 1ª linha com texto, sem a marcação de markdown do começo.
export function noteExcerpt(body: string): string | null {
  for (const raw of body.split('\n')) {
    const line = raw.replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|>\s*|\d+\.\s+)/, '').trim()
    if (line) return line
  }
  return null
}

function childCounts(edges: SessionGraphEdge[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const e of edges) if (e.kind === 'handoff') out.set(e.from, (out.get(e.from) ?? 0) + 1)
  return out
}

interface CardContext {
  sizeOf: (sessionId: string) => Size
  viewOf: (sessionId: string) => CardViewState
  counts: Map<string, number>
  notesBySession: Map<string, string>
  expandedMothers: ReadonlySet<string>
  continuesFrom: Map<string, string>
  mothers: Map<string, { sessionId: string; title: string; onMap: boolean }>
}

function sessionCard(
  n: SessionGraphNode,
  position: Point,
  parentId: string,
  ctx: CardContext,
): MapNode {
  const childCount = ctx.counts.get(n.sessionId) ?? 0
  const data: SessionCardData = {
    node: n,
    childCount,
    summaryStale:
      n.lastSummaryAt != null && n.lastActivityAt != null && n.lastActivityAt > n.lastSummaryAt,
    attentionLabel: n.attentionReason ? ATTENTION_LABEL[n.attentionReason] : null,
    continuesFrom: ctx.continuesFrom.get(n.sessionId) ?? null,
    motherOf: ctx.mothers.get(n.sessionId) ?? null,
    noteExcerpt: ctx.notesBySession.get(n.sessionId) ?? null,
    fanCollapsible: childCount > FAN_COLLAPSE_AT,
    fanExpanded: ctx.expandedMothers.has(n.sessionId),
    view: ctx.viewOf(n.sessionId),
  }
  const size = ctx.sizeOf(n.sessionId)
  return {
    id: sessionNodeId(n.sessionId),
    type: 'session',
    parentId,
    position,
    width: size.w,
    height: size.h,
    zIndex: CARD_Z,
    data,
  }
}

interface Layout {
  nodes: MapNode[]
  // Posição absoluta de cada sessão (pra ancorar notas presas).
  sessionAbs: Map<string, Point>
  laneBoxes: Box[]
  // Borda direita de cada lane de projeto, indexada pela sessão que ela contém.
  gutterBySession: Map<string, number>
}

function layoutLanes(
  input: MapInput,
  sessions: SessionGraphNode[],
  grouped: Set<string>,
  saved: SavedIndex,
  ctx: CardContext,
  noteCountByLane: Map<string, number>,
): Layout {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]))
  const nodes: MapNode[] = []
  const sessionAbs = new Map<string, Point>()
  const laneBoxes: Box[] = []
  const gutterBySession = new Map<string, number>()
  let cursorX = 0

  for (const lane of input.graph.lanes) {
    const repos = lane.repos
      .map((r) => ({
        ...r,
        sessionIds: sortForLane(
          r.sessionIds.filter((id) => byId.has(id) && !grouped.has(id)).map((id) => byId.get(id)!),
        ).map((n) => n.sessionId),
      }))
      .filter((r) => r.sessionIds.length > 0)
    const laneSessions = repos.flatMap((r) => r.sessionIds.map((id) => byId.get(id)!))
    if (repos.length === 0) continue

    const laneId = projectLaneId(lane.projectId)
    const laneNodeIndex = nodes.length
    nodes.push({} as MapNode)
    let repoX = PAD
    let laneH = HEADER + CARD_H + 2 * PAD
    const repoNodes: MapNode[] = []
    const cards: MapNode[] = []
    for (const repo of repos) {
      const heightOf = (id: string) => ctx.sizeOf(id).h
      const slots = stackChildren(repo.sessionIds, (id) => saved.get(`session:${id}`), heightOf)
      const box = fit(slots, ctx.sizeOf, { w: GROUP_MIN_W, h: GROUP_MIN_H })
      const repoPos = { x: repoX, y: HEADER }
      const repoId = repoLaneId(repo.repoId)
      repoNodes.push({
        id: repoId,
        type: 'lane',
        parentId: laneId,
        position: repoPos,
        width: box.w,
        height: box.h,
        draggable: false,
        selectable: false,
        data: {
          level: 'repo',
          label: repo.label,
          color: lane.color,
          projectId: lane.projectId,
          repoId: repo.repoId,
        } satisfies LaneData,
      })
      for (const id of repo.sessionIds)
        cards.push(sessionCard(byId.get(id)!, slots.get(id)!, repoId, ctx))
      repoX += box.w + GAP
      laneH = Math.max(laneH, HEADER + box.h + PAD)
    }
    const laneW = repoX - GAP + PAD
    const savedLane = saved.get(`lane:${laneId.slice(5)}`)
    const lanePos = savedLane ? { x: savedLane.x, y: savedLane.y } : { x: cursorX, y: 0 }
    nodes[laneNodeIndex] = {
      id: laneId,
      type: 'lane',
      position: lanePos,
      width: laneW,
      height: laneH,
      data: {
        level: 'project',
        label: lane.name,
        color: lane.color,
        projectId: lane.projectId,
        repoId: null,
        attentionCount: laneSessions.filter((n) => n.attentionReason).length,
      } satisfies LaneData,
    }
    nodes.push(...repoNodes, ...cards)
    for (const card of cards) {
      const repo = repoNodes.find((r) => r.id === card.parentId)!
      const sessionId = card.id.slice(2)
      sessionAbs.set(sessionId, {
        x: lanePos.x + repo.position.x + card.position.x,
        y: lanePos.y + repo.position.y + card.position.y,
      })
      gutterBySession.set(sessionId, lanePos.x + laneW)
    }
    laneBoxes.push({ ...lanePos, w: laneW, h: laneH })
    const gutter = (noteCountByLane.get(laneId) ?? 0) > 0 ? NOTE_W + LANE_GAP : 0
    cursorX = Math.max(cursorX, lanePos.x + laneW + gutter + LANE_GAP)
  }
  return { nodes, sessionAbs, laneBoxes, gutterBySession }
}

function visibleGroups(input: MapInput, sessions: SessionGraphNode[]): SessionGroup[] {
  const withMembers = new Set(sessions.map((s) => s.groupId).filter(Boolean))
  return input.groups.filter((g) => g.scope === input.scope || withMembers.has(g.id))
}

function layoutGroups(
  groups: SessionGroup[],
  sessions: SessionGraphNode[],
  saved: SavedIndex,
  ctx: CardContext,
  top: number,
  sessionAbs: Map<string, Point>,
): { nodes: MapNode[]; boxes: Box[] } {
  const nodes: MapNode[] = []
  const boxes: Box[] = []
  let cursorX = 0
  for (const g of groups) {
    const members = sortForLane(sessions.filter((s) => s.groupId === g.id))
    const slots = stackChildren(
      members.map((m) => m.sessionId),
      (id) => saved.get(`session:${id}`),
      (id) => ctx.sizeOf(id).h,
    )
    const box = fit(slots, ctx.sizeOf, { w: GROUP_MIN_W, h: GROUP_MIN_H })
    const s = saved.get(`group:${g.id}`)
    const pos = s ? { x: s.x, y: s.y } : { x: cursorX, y: top }
    const id = groupNodeId(g.id)
    nodes.push({
      id,
      type: 'userGroup',
      position: pos,
      width: box.w,
      height: box.h,
      data: { group: g, memberCount: members.length } satisfies UserGroupData,
    })
    for (const m of members) {
      const p = slots.get(m.sessionId)!
      nodes.push(sessionCard(m, p, id, ctx))
      sessionAbs.set(m.sessionId, { x: pos.x + p.x, y: pos.y + p.y })
    }
    boxes.push({ ...pos, ...box })
    cursorX = Math.max(cursorX, pos.x + box.w + LANE_GAP)
  }
  return { nodes, boxes }
}

function layoutNotes(
  notes: CanvasNote[],
  saved: SavedIndex,
  sessionAbs: Map<string, Point>,
  gutterBySession: Map<string, number>,
  top: number,
  isOrphan: (n: CanvasNote) => boolean,
): MapNode[] {
  const out: MapNode[] = []
  const gutterBottom = new Map<number, number>()
  let looseX = 0
  for (const note of notes) {
    const s = saved.get(`note:${note.id}`)
    const size = { w: s?.w ?? NOTE_W, h: s?.h ?? NOTE_H }
    let pos: Point
    if (s) pos = { x: s.x, y: s.y }
    else if (note.attachedSessionId && sessionAbs.has(note.attachedSessionId)) {
      const anchor = sessionAbs.get(note.attachedSessionId)!
      const gutter = gutterBySession.get(note.attachedSessionId)
      const x = gutter !== undefined ? gutter + LANE_GAP / 2 : anchor.x + CARD_W + LANE_GAP / 2
      const y = Math.max(anchor.y, gutterBottom.get(x) ?? -Infinity)
      gutterBottom.set(x, y + size.h + GAP)
      pos = { x, y }
    } else {
      pos = { x: looseX, y: top - size.h - LANE_GAP }
      looseX += size.w + GAP
    }
    out.push({
      id: noteNodeId(note.id),
      type: 'note',
      position: pos,
      width: size.w,
      height: size.h,
      zIndex: CARD_Z,
      data: (isOrphan(note) ? { note, sessionEnded: true } : { note }) satisfies NoteData,
    })
  }
  return out
}

function edge(
  id: string,
  source: string,
  target: string,
  data: Partial<MapEdgeData> & Pick<MapEdgeData, 'kind'>,
): MapEdge {
  return {
    id,
    source,
    target,
    type: 'session',
    zIndex: data.kind === 'repoDep' ? REPO_DEP_EDGE_Z : EDGE_Z,
    data: { live: false, alert: false, label: null, handoffId: null, ...data },
  }
}

function graphEdges(
  edges: SessionGraphEdge[],
  has: (id: string) => boolean,
  isFanned: (motherId: string) => boolean,
): MapEdge[] {
  const out: MapEdge[] = []
  for (const e of edges) {
    if (e.kind === 'handoff') {
      out.push(
        edge(`e:h:${e.handoffId}`, sessionNodeId(e.from), sessionNodeId(e.to), {
          kind: 'handoff',
          live: e.handoffStatus === 'running',
          alert: e.handoffStatus === 'needs_input',
          label: e.currentStep,
          handoffId: e.handoffId,
          ...(isFanned(e.from) ? { fanned: true } : {}),
        }),
      )
    } else if (e.kind === 'baton') {
      out.push(
        edge(`e:b:${e.handoffId}`, sessionNodeId(e.from), sessionNodeId(e.to), {
          kind: 'baton',
          label: '⟲',
          handoffId: e.handoffId,
        }),
      )
    } else if (e.kind === 'repoDep') {
      out.push(
        edge(
          `e:r:${e.fromRepoId}:${e.toRepoId}`,
          repoLaneId(e.fromRepoId),
          repoLaneId(e.toRepoId),
          {
            kind: 'repoDep',
          },
        ),
      )
    } else {
      e.sessionIds.slice(1).forEach((to, i) => {
        out.push(
          edge(`e:f:${e.featureId}:${i}`, sessionNodeId(e.sessionIds[i]), sessionNodeId(to), {
            kind: 'feature',
          }),
        )
      })
    }
  }
  return out.filter((e) => has(e.source) && has(e.target))
}

export interface FlowResult {
  nodes: MapNode[]
  edges: MapEdge[]
}

export function graphToFlow(input: MapInput): FlowResult {
  const inUse = inUseIds(input)
  const sessions = scopedSessions(input, inUse)
  const visibleIds = new Set(sessions.map((s) => s.sessionId))
  const groups = visibleGroups(input, sessions)
  const groupIds = new Set(groups.map((g) => g.id))
  const grouped = new Set(
    sessions.filter((s) => s.groupId && groupIds.has(s.groupId)).map((s) => s.sessionId),
  )
  const isOrphan = (n: CanvasNote) => !!n.attachedSessionId && !inUse.has(n.attachedSessionId)
  // Nota de sessão que encerrou não some (é conteúdo do usuário): fica solta no
  // escopo onde nasceu, marcada, pra ele editar ou apagar.
  const notes = input.notes.filter((n) =>
    n.attachedSessionId && !isOrphan(n)
      ? visibleIds.has(n.attachedSessionId)
      : n.scope === input.scope,
  )
  const saved = savedIndex(input.positions)
  const counts = childCounts(input.graph.edges)
  const expandedMothers = input.expandedMothers ?? new Set<string>()
  // Nota mais recente presa a cada sessão visível: o rodapé do cartão mostra a 1ª linha.
  const notesBySession = new Map<string, string>()
  for (const n of [...notes].sort((a, b) => a.updatedAt - b.updatedAt)) {
    const excerpt = noteExcerpt(n.bodyMd)
    if (n.attachedSessionId && excerpt) notesBySession.set(n.attachedSessionId, excerpt)
  }
  const views = input.views ?? {}
  const ctx: CardContext = {
    viewOf: (id) => viewOf(views, id),
    sizeOf: (id) => cardSize(viewOf(views, id), input.terminalSizes?.[id]),
    counts,
    notesBySession,
    expandedMothers,
    continuesFrom: continuations(input.graph, inUse),
    mothers: mothersOf(input.graph, inUse),
  }
  const laneOf = new Map(
    sessions.map((s) => [
      s.sessionId,
      grouped.has(s.sessionId) ? null : projectLaneId(s.projectId),
    ]),
  )
  const noteCountByLane = new Map<string, number>()
  for (const n of notes) {
    const lane = n.attachedSessionId ? laneOf.get(n.attachedSessionId) : undefined
    if (lane) noteCountByLane.set(lane, (noteCountByLane.get(lane) ?? 0) + 1)
  }

  const lanes = layoutLanes(input, sessions, grouped, saved, ctx, noteCountByLane)
  const lanesBottom = Math.max(0, ...lanes.laneBoxes.map((b) => b.y + b.h))
  const grp = layoutGroups(
    groups,
    sessions.filter((s) => grouped.has(s.sessionId)),
    saved,
    ctx,
    lanesBottom + LANE_GAP,
    lanes.sessionAbs,
  )
  const top = Math.min(0, ...lanes.laneBoxes.map((b) => b.y))
  const noteNodes = layoutNotes(
    notes,
    saved,
    lanes.sessionAbs,
    lanes.gutterBySession,
    top,
    isOrphan,
  )

  const nodes = [...lanes.nodes, ...grp.nodes, ...noteNodes]
  const ids = new Set(nodes.map((n) => n.id))
  const raw = [
    ...graphEdges(
      input.graph.edges,
      (id) => ids.has(id),
      (mother) => (counts.get(mother) ?? 0) > FAN_COLLAPSE_AT && !expandedMothers.has(mother),
    ),
    ...notes
      .filter((n) => n.attachedSessionId && !isOrphan(n))
      .map((n) =>
        edge(`e:n:${n.id}`, noteNodeId(n.id), sessionNodeId(n.attachedSessionId!), {
          kind: 'note',
        }),
      ),
  ]
  // feature (mesma frente) só aparece no foco, sempre; repoDep só com o mapa cheio.
  const busy = raw.length > EDGE_BUSY_THRESHOLD
  const edges = raw.map((e) => {
    const kind = e.data!.kind
    const aggregate = kind === 'feature' || (busy && kind === 'repoDep')
    if (!busy && !aggregate) return e
    return { ...e, data: { ...e.data!, ...(busy ? { busy: true } : {}), aggregate } }
  })
  return { nodes, edges }
}
