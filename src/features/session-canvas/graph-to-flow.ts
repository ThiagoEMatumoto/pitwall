// PURO: grafo de sessões + estado do canvas → nós/arestas do @xyflow/react.
//
// Hierarquia: card da feature (ou "Sem feature · <Projeto>") → lane de repo →
// cartão de sessão (parentId, posições relativas ao pai). Dentro do card a mãe
// fica acima das filhas (faixas por geração) e a antecessora do bastão ao lado
// da sucessora. Sessão num grupo do usuário sai da lane e vira
// filha do grupo. Notas ficam na raiz: soltas numa faixa acima das lanes, presas
// numa calha à direita da lane da sessão. Sem posição salva, cada peça cai num
// slot determinístico (é o mesmo layout que o Organizar grava — tidy.ts).
import type { Edge, Node } from '@xyflow/react'
import type {
  SessionGraph,
  SessionGraphAttention,
  SessionGraphEdge,
  SessionGraphLane,
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

// Cartão recolhido (identidade + estado). Aberto cresce: a saída ao vivo precisa
// de ~55 colunas legíveis.
// Recolhido é UMA linha (ponto + alias + motivo); aberto é a vaga máxima — o
// cartão desenhado só ocupa o que tem (saída ao vivo sem caixa vazia).
export const CARD_W = 248
export const CARD_H = 40
export const OPEN_W = 400
export const OPEN_H = 300
export const NOTE_W = 220
export const NOTE_H = 132
const GAP = 16
const PAD = 12
const HEADER = 30
// Faixa do cabeçalho de lane/grupo acima do primeiro cartão (a toolbar não a cobre).
export const LANE_HEADER_H = HEADER
const LANE_GAP = 48
const GROUP_MIN_W = CARD_W + 2 * PAD
const GROUP_MIN_H = HEADER + 72
// Cabeçalho do card da feature: título + status/contadores + pulso de 1 linha.
export const FEATURE_HEADER = 58
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
  // Estado de exibição de cada cartão (ausente = 'open').
  views?: ViewMap
  // Asks agente↔agente pendentes (P7): fio temporário até a resposta/expiração.
  asks?: readonly PendingAsk[]
}

export interface PendingAsk {
  id: string
  from: string
  to: string
  text: string
}

export function cardSize(view: CardViewState): Size {
  return view === 'collapsed' ? { w: CARD_W, h: CARD_H } : { w: OPEN_W, h: OPEN_H }
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
  // 'feature' = card da feature; 'project' = "Sem feature · <Projeto>"/avulsas.
  level: 'feature' | 'project' | 'repo'
  label: string
  color: string | null
  projectId: string | null
  repoId: string | null
  // Só no topo (feature/projeto): quantas sessões dele pedem você agora.
  attentionCount?: number
  // Só no card da feature.
  featureId?: string
  pulse?: string | null
  status?: string
  pinned?: boolean
  sessionCount?: number
  repoCount?: number
  // Lane de repo dentro do card da feature: projeto quando não é o "home".
  projectName?: string | null
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

export type MapEdgeKind = 'handoff' | 'baton' | 'repoDep' | 'note' | 'ask'

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
export const featureLaneId = (featureId: string) => `lane:f:${featureId}`
export const featureRepoLaneId = (featureId: string, repoId: string | null) =>
  `lane:f:${featureId}:r:${repoId ?? 'loose'}`

function topLaneId(lane: SessionGraphLane): string {
  return lane.kind === 'feature' ? featureLaneId(lane.featureId) : projectLaneId(lane.projectId)
}

function laneRepoId(lane: SessionGraphLane, repoId: string | null): string {
  return lane.kind === 'feature' ? featureRepoLaneId(lane.featureId, repoId) : repoLaneId(repoId)
}

// Lane de repo onde a sessão mora (mesmo estando num grupo do usuário): é pra
// onde ela volta quando sai do grupo.
export function homeRepoLaneId(graph: SessionGraph, sessionId: string): string | null {
  for (const lane of graph.lanes) {
    for (const r of lane.repos) if (r.sessionIds.includes(sessionId)) return laneRepoId(lane, r.repoId)
  }
  return null
}
export const groupNodeId = (id: string) => `g:${id}`
export const noteNodeId = (id: string) => `n:${id}`

// Chave de canvas_positions de cada nó que o usuário pode mover. Lanes de repo
// não: elas se arrumam sozinhas dentro da lane do projeto.
export function positionKey(flowId: string): { kind: CanvasEntityKind; entityId: string } | null {
  if (flowId.startsWith('s:')) return { kind: 'session', entityId: flowId.slice(2) }
  if (flowId.startsWith('n:')) return { kind: 'note', entityId: flowId.slice(2) }
  if (flowId.startsWith('g:')) return { kind: 'group', entityId: flowId.slice(2) }
  if (flowId.startsWith('lane:p:')) return { kind: 'lane', entityId: flowId.slice(5) }
  // O card da feature é arrastável; as lanes de repo dentro dele não.
  if (flowId.startsWith('lane:f:') && !flowId.includes(':r:'))
    return { kind: 'lane', entityId: flowId.slice(5) }
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

// No escopo de um projeto, o card de uma feature que o toca (home ou algum repo
// registrado) entra INTEIRO: inclusive as sessões dos repos de outros projetos,
// senão a lane delas aparece vazia e o contador do card mente.
function scopedSessions(input: MapInput, inUse: Set<string>): SessionGraphNode[] {
  const global = input.scope === GLOBAL_CANVAS_SCOPE
  const touching = new Set(
    input.graph.lanes.flatMap((l) =>
      l.kind === 'feature' &&
      (l.projectId === input.scope || l.repos.some((r) => r.projectId === input.scope))
        ? [l.featureId]
        : [],
    ),
  )
  return input.graph.nodes.filter(
    (n) =>
      inUse.has(n.sessionId) &&
      (global || n.projectId === input.scope || (!!n.featureId && touching.has(n.featureId))),
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
  // Borda direita de cada lane de topo, indexada pela sessão que ela contém.
  gutterBySession: Map<string, number>
  // Lanes de repo desenhadas por repo (o mesmo repo pode estar em vários cards).
  repoLaneIds: Map<string, string[]>
}

// Geração de cada sessão dentro do card: filha = mãe + 1, só contando mães do
// MESMO card (a mãe de outro card não empurra ninguém pra baixo).
function generations(sessionIds: string[], mothers: Map<string, string>): Map<string, number> {
  const inLane = new Set(sessionIds)
  const out = new Map<string, number>()
  const depthOf = (id: string, seen: Set<string>): number => {
    const known = out.get(id)
    if (known !== undefined) return known
    const mother = mothers.get(id)
    const d = mother && inLane.has(mother) && !seen.has(mother) ? depthOf(mother, new Set([...seen, id])) + 1 : 0
    out.set(id, d)
    return d
  }
  for (const id of sessionIds) depthOf(id, new Set())
  return out
}

interface LaneRepoCards {
  nodeId: string
  sessionIds: string[]
}

// Slots dos cartões de um card: cada repo é uma coluna; as gerações viram faixas
// horizontais (a filha começa abaixo de toda a geração da mãe, em qualquer
// coluna). A antecessora do bastão vai na mesma linha, à direita da sucessora.
// Posições salvas ficam onde o usuário deixou.
function slotCards(
  repos: LaneRepoCards[],
  ctx: CardContext,
  saved: (id: string) => Point | undefined,
  mothers: Map<string, string>,
  batonPrev: Map<string, string>,
): Map<string, Map<string, Point>> {
  const all = repos.flatMap((r) => r.sessionIds)
  const gen = generations(all, mothers)
  const out = new Map<string, Map<string, Point>>()
  const cursor = new Map<string, number>()
  const rows = new Map<string, string[][]>()
  for (const repo of repos) {
    const slots = new Map<string, Point>()
    let c = HEADER
    for (const id of repo.sessionIds) {
      const p = saved(id)
      if (!p) continue
      slots.set(id, { x: p.x, y: p.y })
      c = Math.max(c, p.y + ctx.sizeOf(id).h + GAP)
    }
    out.set(repo.nodeId, slots)
    cursor.set(repo.nodeId, c)
    // Linhas: cada sucessora puxa a cadeia de antecessoras do MESMO repo.
    const here = new Set(repo.sessionIds.filter((id) => !slots.has(id)))
    const sidecar = new Set<string>()
    for (const id of here) {
      let prev = batonPrev.get(id)
      while (prev && here.has(prev) && !sidecar.has(prev) && prev !== id) {
        sidecar.add(prev)
        prev = batonPrev.get(prev)
      }
    }
    const repoRows: string[][] = []
    for (const id of repo.sessionIds) {
      if (!here.has(id) || sidecar.has(id)) continue
      const row = [id]
      let prev = batonPrev.get(id)
      while (prev && sidecar.has(prev) && !row.includes(prev)) {
        row.push(prev)
        prev = batonPrev.get(prev)
      }
      repoRows.push(row)
    }
    rows.set(repo.nodeId, repoRows)
  }
  // Piso de cada linha: o fundo da PRÓPRIA mãe (se ela está neste card, salva ou
  // já posta — gerações sobem em ordem) e o cursor da coluna. Não a camada da
  // geração inteira do card: uma pilha alta de sessões sem relação em outra
  // coluna empurrava a filha para longe da mãe e abria um vão enorme.
  const posOf = (id: string): Point | undefined => {
    for (const slots of out.values()) {
      const p = slots.get(id)
      if (p) return p
    }
    return undefined
  }
  const motherFloor = (id: string): number => {
    const mother = mothers.get(id)
    const p = mother ? posOf(mother) : undefined
    return p && mother ? p.y + ctx.sizeOf(mother).h + GAP : HEADER
  }
  const maxGen = Math.max(0, ...all.map((id) => gen.get(id) ?? 0))
  for (let d = 0; d <= maxGen; d++) {
    for (const repo of repos) {
      const slots = out.get(repo.nodeId)!
      for (const row of rows.get(repo.nodeId)!) {
        if ((gen.get(row[0]) ?? 0) !== d) continue
        const y = Math.max(motherFloor(row[0]), cursor.get(repo.nodeId)!)
        let x = PAD
        let h = 0
        for (const id of row) {
          slots.set(id, { x, y })
          x += ctx.sizeOf(id).w + GAP
          h = Math.max(h, ctx.sizeOf(id).h)
        }
        cursor.set(repo.nodeId, y + h + GAP)
      }
    }
  }
  return out
}

function laneHeaderData(
  lane: SessionGraphLane,
  laneSessions: SessionGraphNode[],
  repoCount: number,
): LaneData {
  const attentionCount = laneSessions.filter((n) => n.attentionReason).length
  if (lane.kind === 'feature') {
    return {
      level: 'feature',
      label: lane.name,
      color: lane.color,
      projectId: lane.projectId,
      repoId: null,
      attentionCount,
      featureId: lane.featureId,
      pulse: lane.pulse,
      status: lane.status,
      pinned: lane.pinned,
      sessionCount: laneSessions.length,
      repoCount,
      // A toolbar contextual desvia deste cabeçalho (selection-toolbar).
      headerH: FEATURE_HEADER,
    }
  }
  return {
    level: 'project',
    label: lane.name,
    color: lane.color,
    projectId: lane.projectId,
    repoId: null,
    attentionCount,
  }
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
  const repoLaneIds = new Map<string, string[]>()
  const visible = (id: string) => byId.has(id) && !grouped.has(id)
  const mothers = new Map<string, string>()
  const batonPrev = new Map<string, string>()
  for (const e of input.graph.edges) {
    if (e.kind === 'handoff' && visible(e.from) && visible(e.to)) mothers.set(e.to, e.from)
    if (e.kind === 'baton' && visible(e.from) && visible(e.to)) batonPrev.set(e.to, e.from)
  }
  // Migração: a posição salva da lane de projeto antiga vai pro 1º card de
  // feature daquele projeto quando a lane do projeto não aparece mais.
  const shownProjects = new Set<string>()
  const migrated = new Set<string>()
  let cursorX = 0

  const laneLayouts = input.graph.lanes.flatMap((lane) => {
    const repos = lane.repos
      .map((r) => ({
        ...r,
        sessionIds: sortForLane(r.sessionIds.filter(visible).map((id) => byId.get(id)!)).map(
          (n) => n.sessionId,
        ),
      }))
      .filter((r) => r.sessionIds.length > 0 || lane.kind === 'feature')
    const laneSessions = repos.flatMap((r) => r.sessionIds.map((id) => byId.get(id)!))
    if (laneSessions.length === 0) return []
    if (lane.kind === 'project') shownProjects.add(projectLaneId(lane.projectId))
    return [{ lane, repos, laneSessions }]
  })

  // Posição salva de cada card (a própria ou a migrada da lane de projeto), na
  // ordem do grafo para a migração ir pro 1º card do projeto.
  const savedLaneOf = new Map<SessionGraphLane, Point>()
  for (const { lane } of laneLayouts) {
    const laneId = topLaneId(lane)
    let savedLane: Point | undefined = saved.get(`lane:${laneId.slice(5)}`)
    if (!savedLane && lane.kind === 'feature') {
      const old = projectLaneId(lane.projectId)
      if (!shownProjects.has(old) && !migrated.has(old)) {
        savedLane = saved.get(`lane:${old.slice(5)}`)
        if (savedLane) migrated.add(old)
      }
    }
    if (savedLane) savedLaneOf.set(lane, { x: savedLane.x, y: savedLane.y })
  }
  // Os cards com posição salva saem primeiro: o cursor dos que nascem agora
  // começa à direita deles (senão o card novo cai em cima da "Sem feature"
  // que o usuário arrumou no v1).
  const ordered = [
    ...laneLayouts.filter((l) => savedLaneOf.has(l.lane)),
    ...laneLayouts.filter((l) => !savedLaneOf.has(l.lane)),
  ]

  for (const { lane, repos, laneSessions } of ordered) {
    const laneId = topLaneId(lane)
    const laneNodeIndex = nodes.length
    nodes.push({} as MapNode)
    let repoX = PAD
    let laneH = HEADER + CARD_H + 2 * PAD
    const repoNodes: MapNode[] = []
    const cards: MapNode[] = []
    // O card da feature tem um cabeçalho mais alto (título + pulso).
    const top = lane.kind === 'feature' ? FEATURE_HEADER : HEADER
    const cardRepos = repos.map((r) => ({ nodeId: laneRepoId(lane, r.repoId), sessionIds: r.sessionIds }))
    const slotsByRepo = slotCards(
      cardRepos,
      ctx,
      (id) => saved.get(`session:${id}`),
      mothers,
      batonPrev,
    )
    const home = lane.kind === 'feature' ? lane.projectId : null
    for (const repo of repos) {
      const repoId = laneRepoId(lane, repo.repoId)
      const slots = slotsByRepo.get(repoId)!
      const box = fit(slots, ctx.sizeOf, { w: GROUP_MIN_W, h: GROUP_MIN_H })
      repoNodes.push({
        id: repoId,
        type: 'lane',
        parentId: laneId,
        position: { x: repoX, y: top },
        width: box.w,
        height: box.h,
        draggable: false,
        selectable: false,
        data: {
          level: 'repo',
          label: repo.label,
          color: lane.color,
          projectId: repo.projectId ?? lane.projectId,
          repoId: repo.repoId,
          projectName:
            lane.kind === 'feature' && repo.projectId && repo.projectId !== home
              ? (repo.projectName ?? null)
              : null,
        } satisfies LaneData,
      })
      if (repo.repoId) repoLaneIds.set(repo.repoId, [...(repoLaneIds.get(repo.repoId) ?? []), repoId])
      for (const id of repo.sessionIds)
        cards.push(sessionCard(byId.get(id)!, slots.get(id)!, repoId, ctx))
      repoX += box.w + GAP
      laneH = Math.max(laneH, top + box.h + PAD)
    }
    const laneW = repoX - GAP + PAD
    const lanePos = clearOfPlaced(
      savedLaneOf.get(lane) ?? { x: cursorX, y: 0 },
      { w: laneW, h: laneH },
      laneBoxes,
    )
    nodes[laneNodeIndex] = {
      id: laneId,
      type: 'lane',
      position: lanePos,
      width: laneW,
      height: laneH,
      data: laneHeaderData(lane, laneSessions, repos.length),
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
  return { nodes, sessionAbs, laneBoxes, gutterBySession, repoLaneIds }
}

// Card salvo (Organizar grava todos) muda de tamanho sozinho quando a resolução
// contínua move sessões entre cards: ganha lane de repo ou linha e cobriria o
// vizinho, também salvo. Empurra para a direita de quem ele cobriria, sem
// persistir — o lugar salvo volta a valer quando o card encolher.
function clearOfPlaced(pos: Point, size: { w: number; h: number }, placed: Box[]): Point {
  let x = pos.x
  for (let guard = 0; guard <= placed.length; guard++) {
    const hit = placed.find(
      (b) => x < b.x + b.w && x + size.w > b.x && pos.y < b.y + b.h && pos.y + size.h > b.y,
    )
    if (!hit) break
    x = hit.x + hit.w + LANE_GAP
  }
  return x === pos.x ? pos : { x, y: pos.y }
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

// O mesmo repo pode aparecer em vários cards: o fio liga as duas lanes do
// mesmo card quando existe esse par; senão, as primeiras de cada lado.
function repoDepPair(from: string[], to: string[]): [string, string] | null {
  if (!from.length || !to.length) return null
  const card = (id: string) => id.slice(0, id.lastIndexOf(':r:'))
  for (const f of from) {
    const t = to.find((x) => card(x) === card(f))
    if (t) return [f, t]
  }
  return [from[0], to[0]]
}

function graphEdges(
  edges: SessionGraphEdge[],
  has: (id: string) => boolean,
  isFanned: (motherId: string) => boolean,
  repoLaneIds: (repoId: string) => string[],
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
        // Por par, não por handoff: o bastão da mãe carrega o id de um handoff
        // movido, que pode ser o mesmo do bastão da filha desse handoff.
        edge(`e:b:${e.from}:${e.to}`, sessionNodeId(e.from), sessionNodeId(e.to), {
          kind: 'baton',
          label: '⟲',
          handoffId: e.handoffId,
        }),
      )
    } else {
      const pair = repoDepPair(repoLaneIds(e.fromRepoId), repoLaneIds(e.toRepoId))
      if (pair)
        out.push(
          edge(`e:r:${e.fromRepoId}:${e.toRepoId}`, pair[0], pair[1], {
            kind: 'repoDep',
          }),
        )
    }
  }
  return out.filter((e) => has(e.source) && has(e.target))
}

const ASK_LABEL_MAX = 80

function askEdges(asks: readonly PendingAsk[], has: (id: string) => boolean): MapEdge[] {
  return asks
    .map((a) =>
      edge(`e:a:${a.id}`, sessionNodeId(a.from), sessionNodeId(a.to), {
        kind: 'ask',
        live: true,
        label: a.text.length > ASK_LABEL_MAX ? `${a.text.slice(0, ASK_LABEL_MAX - 1)}…` : a.text,
      }),
    )
    .filter((e) => has(e.source) && has(e.target))
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
    sizeOf: (id) => cardSize(viewOf(views, id)),
    counts,
    notesBySession,
    expandedMothers,
    continuesFrom: continuations(input.graph, inUse),
    mothers: mothersOf(input.graph, inUse),
  }
  const topOf = new Map<string, string>()
  for (const lane of input.graph.lanes)
    for (const r of lane.repos) for (const id of r.sessionIds) topOf.set(id, topLaneId(lane))
  const laneOf = new Map(
    sessions.map((s) => [s.sessionId, grouped.has(s.sessionId) ? null : (topOf.get(s.sessionId) ?? null)]),
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
      (repoId) => lanes.repoLaneIds.get(repoId) ?? [],
    ),
    ...notes
      .filter((n) => n.attachedSessionId && !isOrphan(n))
      .map((n) =>
        edge(`e:n:${n.id}`, noteNodeId(n.id), sessionNodeId(n.attachedSessionId!), {
          kind: 'note',
        }),
      ),
    ...askEdges(input.asks ?? [], (id) => ids.has(id)),
  ]
  // repoDep só aparece no foco com o mapa cheio.
  // O fio de ask é temporário e não conta: senão cada pergunta piscaria o mapa.
  const busy = raw.filter((e) => e.data!.kind !== 'ask').length > EDGE_BUSY_THRESHOLD
  const edges = raw.map((e) => {
    const kind = e.data!.kind
    const aggregate = busy && kind === 'repoDep'
    if (!busy && !aggregate) return e
    return { ...e, data: { ...e.data!, ...(busy ? { busy: true } : {}), aggregate } }
  })
  return { nodes, edges }
}
