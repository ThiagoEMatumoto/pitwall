// Grafo de sessões: quem delegou pra quem (handoff), quem herdou o bastão de quem,
// quais repos ligados têm sessões vivas ao mesmo tempo e quais sessões trabalham
// na mesma feature. buildSessionGraph é PURA; readSessionGraphInput só lê o banco
// (recebe o db por parâmetro, sem electron) — o wrapper vivo mora no ipc.
import type Database from 'better-sqlite3'
import type { AgentProviderId, HandoffStatus } from '../../../shared/types/ipc'
import type {
  SessionGraph,
  SessionGraphAttention,
  SessionGraphEdge,
  SessionGraphLane,
  SessionGraphNode,
  SessionGraphStatus,
} from '../../../shared/types/session-graph'

// Estado vivo por sessions.id (PTY + ~/.claude/sessions/<pid>.json). Ausente = ended.
export interface LiveSessionState {
  status: SessionGraphStatus
  lastActivityAt: number | null
  // Nome que o CLI reporta no session file (o mesmo activity.name da aba).
  name: string | null
}

export interface GraphSessionRow {
  id: string
  repo_id: string | null
  cc_session_id: string | null
  title: string | null
  title_source: 'manual' | 'auto' | null
  provider: AgentProviderId
  feature_id: string | null
  started_at: number
}

export interface GraphHandoffRow {
  id: string
  mother_session_id: string | null
  child_session_id: string | null
  predecessor_session_id: string | null
  task: string
  status: HandoffStatus
  current_step: string | null
  created_at: number
}

export interface GraphRepoRow {
  id: string
  project_id: string
  label: string
  position: number
}

export interface GraphProjectRow {
  id: string
  name: string
  color: string | null
  position: number
}

export interface GraphRepoDepRow {
  from_repo_id: string
  to_repo_id: string
  kind: string
}

export interface GraphFeatureRecordRow {
  session_id: string
  feature_id: string
}

export interface SessionGraphInput {
  sessions: GraphSessionRow[]
  // Só handoffs fora do Crew Dock dispensado (o leitor já filtra).
  handoffs: GraphHandoffRow[]
  repos: GraphRepoRow[]
  projects: GraphProjectRow[]
  repoDependencies: GraphRepoDepRow[]
  featureRecords: GraphFeatureRecordRow[]
  live: Map<string, LiveSessionState>
}

const LOOSE_LABEL = 'Avulsas'

// Espelha o displayTitle do Terminal.tsx: rename manual > nome vivo do CLI >
// título salvo > label do repo.
export function sessionNodeTitle(args: {
  title: string | null
  titleSource: 'manual' | 'auto' | null
  liveName: string | null
  repoLabel: string | null
}): string {
  const manual = args.titleSource === 'manual' ? args.title : null
  return manual || args.liveName || args.title || args.repoLabel || 'Avulsa'
}

function attentionFor(
  handoff: GraphHandoffRow | undefined,
  status: SessionGraphStatus,
): SessionGraphAttention | null {
  if (handoff?.status === 'needs_input') return 'handoff-input'
  if (status === 'waiting') return 'waiting'
  return null
}

function buildNodes(input: SessionGraphInput, childHandoff: Map<string, GraphHandoffRow>) {
  const repoById = new Map(input.repos.map((r) => [r.id, r]))
  const sorted = [...input.sessions].sort(
    (a, b) => a.started_at - b.started_at || a.id.localeCompare(b.id),
  )
  return sorted.map((s): SessionGraphNode => {
    const repo = s.repo_id ? repoById.get(s.repo_id) : undefined
    const live = input.live.get(s.id)
    const status = live?.status ?? 'ended'
    const handoff = childHandoff.get(s.id)
    return {
      sessionId: s.id,
      ccSessionId: s.cc_session_id,
      title: sessionNodeTitle({
        title: s.title,
        titleSource: s.title_source,
        liveName: live?.name ?? null,
        repoLabel: repo?.label ?? null,
      }),
      projectId: repo?.project_id ?? null,
      repoId: repo ? repo.id : null,
      repoLabel: repo?.label ?? null,
      provider: s.provider,
      status,
      attentionReason: attentionFor(handoff, status),
      lastActivityAt: live?.lastActivityAt ?? null,
      purposeHint: handoff?.task ?? null,
      childOfHandoffId: handoff?.id ?? null,
    }
  })
}

// Um handoff por filha: o mais recente vence (a mesma sessão pode ter sido filha
// de um handoff antigo já concluído).
function childHandoffIndex(handoffs: GraphHandoffRow[]): Map<string, GraphHandoffRow> {
  const out = new Map<string, GraphHandoffRow>()
  for (const h of handoffs) {
    if (!h.child_session_id) continue
    const prev = out.get(h.child_session_id)
    if (!prev || prev.created_at <= h.created_at) out.set(h.child_session_id, h)
  }
  return out
}

// Fio mãe→filha só do handoff que o nó da filha adota (childHandoffIndex): uma
// sessão readotada por outra mãe não pode ter o chip da mãe antiga com a tarefa
// da nova, nem continuar contando como filha da antiga.
function lineageEdges(
  handoffs: GraphHandoffRow[],
  ids: Set<string>,
  childHandoff: Map<string, GraphHandoffRow>,
): SessionGraphEdge[] {
  const byCreation = [...handoffs].sort((a, b) => a.created_at - b.created_at)
  const out: SessionGraphEdge[] = []
  for (const h of byCreation) {
    const child = h.child_session_id
    if (!child || !ids.has(child) || childHandoff.get(child)?.id !== h.id) continue
    const mother = h.mother_session_id
    if (mother && mother !== child && ids.has(mother)) {
      out.push({
        kind: 'handoff',
        from: mother,
        to: child,
        handoffId: h.id,
        handoffStatus: h.status,
        currentStep: h.current_step,
        createdAt: h.created_at,
      })
    }
  }
  for (const h of byCreation) {
    const pred = h.predecessor_session_id
    const child = h.child_session_id
    if (pred && child && pred !== child && ids.has(pred) && ids.has(child)) {
      out.push({ kind: 'baton', from: pred, to: child, handoffId: h.id })
    }
  }
  return out
}

function repoDepEdges(deps: GraphRepoDepRow[], nodes: SessionGraphNode[]): SessionGraphEdge[] {
  const liveByRepo = new Map<string, string[]>()
  for (const n of nodes) {
    if (!n.repoId || n.status === 'ended') continue
    liveByRepo.set(n.repoId, [...(liveByRepo.get(n.repoId) ?? []), n.sessionId])
  }
  const kindsByPair = new Map<string, { from: string; to: string; kinds: string[] }>()
  for (const d of deps) {
    if (d.from_repo_id === d.to_repo_id) continue
    if (!liveByRepo.has(d.from_repo_id) || !liveByRepo.has(d.to_repo_id)) continue
    const key = `${d.from_repo_id}\u0000${d.to_repo_id}`
    const prev = kindsByPair.get(key)
    kindsByPair.set(key, {
      from: d.from_repo_id,
      to: d.to_repo_id,
      kinds: prev ? [...prev.kinds, d.kind] : [d.kind],
    })
  }
  return [...kindsByPair.values()].map((p) => ({
    kind: 'repoDep',
    fromRepoId: p.from,
    toRepoId: p.to,
    depKinds: [...new Set(p.kinds)].sort(),
    fromSessionIds: liveByRepo.get(p.from) ?? [],
    toSessionIds: liveByRepo.get(p.to) ?? [],
  }))
}

function featureEdges(input: SessionGraphInput, nodes: SessionGraphNode[]): SessionGraphEdge[] {
  const featuresBySession = new Map<string, Set<string>>()
  const add = (sessionId: string, featureId: string | null) => {
    if (!featureId) return
    featuresBySession.set(
      sessionId,
      new Set([...(featuresBySession.get(sessionId) ?? []), featureId]),
    )
  }
  for (const s of input.sessions) add(s.id, s.feature_id)
  for (const r of input.featureRecords) add(r.session_id, r.feature_id)

  const sessionsByFeature = new Map<string, string[]>()
  for (const n of nodes) {
    for (const f of featuresBySession.get(n.sessionId) ?? []) {
      sessionsByFeature.set(f, [...(sessionsByFeature.get(f) ?? []), n.sessionId])
    }
  }
  return [...sessionsByFeature.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([featureId, sessionIds]) => ({ kind: 'feature', featureId, sessionIds }))
}

function buildLanes(input: SessionGraphInput, nodes: SessionGraphNode[]): SessionGraphLane[] {
  const byRepo = new Map<string, string[]>()
  const loose: string[] = []
  for (const n of nodes) {
    if (n.repoId) byRepo.set(n.repoId, [...(byRepo.get(n.repoId) ?? []), n.sessionId])
    else loose.push(n.sessionId)
  }
  const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position
  const lanes: SessionGraphLane[] = [...input.projects].sort(byPosition).flatMap((p) => {
    const repos = input.repos
      .filter((r) => r.project_id === p.id && byRepo.has(r.id))
      .sort(byPosition)
      .map((r) => ({ repoId: r.id, label: r.label, sessionIds: byRepo.get(r.id) ?? [] }))
    return repos.length ? [{ projectId: p.id, name: p.name, color: p.color, repos }] : []
  })
  if (loose.length) {
    lanes.push({
      projectId: null,
      name: LOOSE_LABEL,
      color: null,
      repos: [{ repoId: null, label: LOOSE_LABEL, sessionIds: loose }],
    })
  }
  return lanes
}

export function buildSessionGraph(input: SessionGraphInput): SessionGraph {
  const childHandoff = childHandoffIndex(input.handoffs)
  const nodes = buildNodes(input, childHandoff)
  const ids = new Set(nodes.map((n) => n.sessionId))
  return {
    nodes,
    lanes: buildLanes(input, nodes),
    edges: [
      ...lineageEdges(input.handoffs, ids, childHandoff),
      ...repoDepEdges(input.repoDependencies, nodes),
      ...featureEdges(input, nodes),
    ],
  }
}

// Handoff encerrado só é contexto recente: sem teto, uma mãe de longa data
// arrasta dezenas de filhas mortas pro grafo (e pro chip). Ativo e needs_input
// entram sempre. 'interrupted' não é terminal (é retomável).
export const TERMINAL_GRAPH_STATUSES = ['done', 'failed', 'rejected'] as const
export const TERMINAL_HANDOFF_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const TERMINAL_HANDOFFS_PER_MOTHER = 20

const HANDOFF_COLUMNS = `id, mother_session_id, child_session_id, predecessor_session_id, task,
       status, current_step, created_at`

function readGraphHandoffs(db: Database.Database, now: number): GraphHandoffRow[] {
  const terminal = JSON.stringify(TERMINAL_GRAPH_STATUSES)
  return db
    .prepare(
      `SELECT ${HANDOFF_COLUMNS} FROM handoffs
        WHERE dismissed_at IS NULL AND status NOT IN (SELECT value FROM json_each(?))
       UNION ALL
       SELECT ${HANDOFF_COLUMNS} FROM (
         SELECT *, ROW_NUMBER() OVER (
                  PARTITION BY mother_session_id ORDER BY updated_at DESC, id
                ) AS rank_in_mother
           FROM handoffs
          WHERE dismissed_at IS NULL AND status IN (SELECT value FROM json_each(?))
            AND updated_at >= ?
       ) WHERE rank_in_mother <= ?`,
    )
    .all(
      terminal,
      terminal,
      now - TERMINAL_HANDOFF_WINDOW_MS,
      TERMINAL_HANDOFFS_PER_MOTHER,
    ) as GraphHandoffRow[]
}

// Nós = sessões vivas + as que os handoffs em vista citam (mãe, filha,
// antecessora do bastão). Uma mãe encerrada continua sendo "de onde a filha saiu".
export function readSessionGraphInput(
  db: Database.Database,
  live: Map<string, LiveSessionState>,
  now = Date.now(),
): SessionGraphInput {
  const handoffs = readGraphHandoffs(db, now)

  const referenced = handoffs.flatMap((h) =>
    [h.mother_session_id, h.child_session_id, h.predecessor_session_id].filter(
      (id): id is string => !!id,
    ),
  )
  const ids = JSON.stringify([...new Set([...live.keys(), ...referenced])])

  const sessions = db
    .prepare(
      `SELECT id, repo_id, cc_session_id, title, title_source, provider, feature_id, started_at
         FROM sessions WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .all(ids) as GraphSessionRow[]
  const featureRecords = db
    .prepare(
      `SELECT session_id, feature_id FROM feature_session_records
        WHERE session_id IN (SELECT value FROM json_each(?))`,
    )
    .all(ids) as GraphFeatureRecordRow[]

  return {
    sessions,
    handoffs,
    featureRecords,
    repos: db.prepare('SELECT id, project_id, label, position FROM repos').all() as GraphRepoRow[],
    projects: db
      .prepare('SELECT id, name, color, position FROM projects')
      .all() as GraphProjectRow[],
    repoDependencies: db
      .prepare('SELECT from_repo_id, to_repo_id, kind FROM repo_dependencies')
      .all() as GraphRepoDepRow[],
    live,
  }
}
