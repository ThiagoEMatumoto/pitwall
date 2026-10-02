// Grafo de sessões: quem delegou pra quem (handoff), quem herdou o bastão de quem,
// quais repos ligados têm sessões vivas ao mesmo tempo e, no topo, o card de cada
// feature (sessões agrupadas por sessions.feature_id). buildSessionGraph é PURA; readSessionGraphInput só lê o banco
// (recebe o db por parâmetro, sem electron) — o wrapper vivo mora no ipc.
import type Database from 'better-sqlite3'
import type { AgentProviderId, HandoffStatus } from '../../../shared/types/ipc'
import type {
  SessionGraph,
  SessionGraphAttention,
  SessionGraphEdge,
  SessionGraphLane,
  SessionGraphLaneRepo,
  SessionGraphNode,
  SessionGraphStatus,
} from '../../../shared/types/session-graph'
import { resolvePurpose } from './session-purpose'
import { isResumableChild } from './handoff-store'
import { isLedByMother } from '../../../shared/handoff-lead'

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
  ended_at?: number | null
  purpose: string | null
  group_id: string | null
  last_summary: string | null
  last_summary_at: number | null
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
  // Só 'interrupted' com transcript da filha no disco (isResumableChild). O
  // readGraphHandoffs já tira os dispensados.
  resumable?: boolean
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

// Features não-arquivadas citadas pelas sessões do grafo, com o pulso vigente.
export interface GraphFeatureRow {
  id: string
  project_id: string
  title: string
  status: string
  pinned: number
  pulse: string | null
}

export interface GraphFeatureRepoRow {
  feature_id: string
  repo_id: string
}

// handoff_events 'mother_transferred' (handoffStore.transferMother): de quem
// para quem a liderança de um handoff passou.
export interface GraphMotherTransfer {
  handoff_id: string
  from: string
  to: string
  at: number
}

export interface SessionGraphInput {
  sessions: GraphSessionRow[]
  // Só handoffs fora do Crew Dock dispensado (o leitor já filtra).
  handoffs: GraphHandoffRow[]
  repos: GraphRepoRow[]
  projects: GraphProjectRow[]
  repoDependencies: GraphRepoDepRow[]
  features?: GraphFeatureRow[]
  featureRepos?: GraphFeatureRepoRow[]
  live: Map<string, LiveSessionState>
  // 1º prompt humano por sessions.id — só pra quem não tem propósito melhor.
  firstPrompts?: Map<string, string | null>
  // Tarefa do handoff mais recente em que a sessão foi filha/antecessora, mesmo
  // fora da janela de handoffs do grafo (a mãe de hoje foi filha semana passada).
  pastTasks?: Map<string, string>
  // Última mensagem humana por sessions.id (fallback do "Onde parei").
  lastPrompts?: Map<string, string | null>
  motherTransfers?: GraphMotherTransfer[]
}

const LOOSE_LABEL = 'Avulsas'
export const NO_FEATURE_PREFIX = 'Sem feature · '

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

// Quem passou o bastão deixa de ser filha (o handoff aponta pra sucessora), mas a
// tarefa que ela carregava continua sendo "do que ela se trata" — sem isto a
// antecessora viva virava "Sem propósito" no mapa. O handoff mais recente vence.
function predecessorHandoffIndex(handoffs: GraphHandoffRow[]): Map<string, GraphHandoffRow> {
  const out = new Map<string, GraphHandoffRow>()
  for (const h of handoffs) {
    const pred = h.predecessor_session_id
    if (!pred || pred === h.child_session_id) continue
    const prev = out.get(pred)
    if (!prev || prev.created_at <= h.created_at) out.set(pred, h)
  }
  return out
}

// Filhas por mãe, no recorte do bastão (isLedByMother): o badge promete
// exatamente quem o bastão vai relinkar. Com filha atrelada, só o handoff que ela
// adota (childHandoffIndex), pra uma sessão readotada não contar pras duas mães;
// pending/approved ainda sem filha contam — o bastão também os move.
function childCountByMother(
  handoffs: GraphHandoffRow[],
  childHandoff: Map<string, GraphHandoffRow>,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const h of handoffs) {
    const mother = h.mother_session_id
    const child = h.child_session_id
    if (!mother || mother === child) continue
    if (!isLedByMother({ status: h.status, dismissedAt: null, resumable: h.resumable ?? false }))
      continue
    if (child && childHandoff.get(child)?.id !== h.id) continue
    out.set(mother, (out.get(mother) ?? 0) + 1)
  }
  return out
}

function buildNodes(input: SessionGraphInput, childHandoff: Map<string, GraphHandoffRow>) {
  const passedBaton = predecessorHandoffIndex(input.handoffs)
  const children = childCountByMother(input.handoffs, childHandoff)
  const gaveMotherBaton = new Set(
    (input.motherTransfers ?? []).filter((t) => t.from !== t.to).map((t) => t.from),
  )
  const repoById = new Map(input.repos.map((r) => [r.id, r]))
  const featureById = new Map((input.features ?? []).map((f) => [f.id, f]))
  const sorted = [...input.sessions].sort(
    (a, b) => a.started_at - b.started_at || a.id.localeCompare(b.id),
  )
  return sorted.map((s): SessionGraphNode => {
    const repo = s.repo_id ? repoById.get(s.repo_id) : undefined
    const live = input.live.get(s.id)
    const status = live?.status ?? 'ended'
    const handoff = childHandoff.get(s.id)
    const purpose = resolvePurpose({
      userPurpose: s.purpose,
      handoffTask:
        handoff?.task ?? passedBaton.get(s.id)?.task ?? input.pastTasks?.get(s.id) ?? null,
      firstPrompt: input.firstPrompts?.get(s.id) ?? null,
    })
    return {
      sessionId: s.id,
      ccSessionId: s.cc_session_id,
      title: sessionNodeTitle({
        title: s.title,
        titleSource: s.title_source,
        liveName: live?.name ?? null,
        repoLabel: repo?.label ?? null,
      }),
      cliName: live?.name ?? null,
      projectId: repo?.project_id ?? null,
      repoId: repo ? repo.id : null,
      repoLabel: repo?.label ?? null,
      provider: s.provider,
      status,
      attentionReason: attentionFor(handoff, status),
      lastActivityAt: live?.lastActivityAt ?? null,
      startedAt: s.started_at,
      endedAt: live ? null : (s.ended_at ?? null),
      purposeHint: handoff?.task ?? null,
      purpose: purpose?.text ?? null,
      purposeSource: purpose?.source ?? null,
      groupId: s.group_id ?? null,
      featureId: (s.feature_id && featureById.get(s.feature_id)?.id) ?? null,
      featureTitle: (s.feature_id && featureById.get(s.feature_id)?.title) ?? null,
      lastSummary: s.last_summary ?? null,
      lastSummaryAt: s.last_summary_at ?? null,
      lastPrompt: input.lastPrompts?.get(s.id) ?? null,
      childOfHandoffId: handoff?.id ?? null,
      isMother: (children.get(s.id) ?? 0) > 0,
      childCount: children.get(s.id) ?? 0,
      batonPassed: gaveMotherBaton.has(s.id) && !children.has(s.id),
    }
  })
}

// Bastão da mãe: um fio por par antecessora→sucessora (não um por handoff movido).
// `drawn`: pares já desenhados pela linhagem — a mãe que também é filha passa um
// bastão só, que aparece nos dois registros.
function motherBatonEdges(
  transfers: GraphMotherTransfer[],
  ids: Set<string>,
  drawn: SessionGraphEdge[],
): SessionGraphEdge[] {
  const seen = new Set(drawn.filter((e) => e.kind === 'baton').map((e) => `${e.from}\u0000${e.to}`))
  const out: SessionGraphEdge[] = []
  for (const t of [...transfers].sort((a, b) => a.at - b.at)) {
    const key = `${t.from}\u0000${t.to}`
    if (t.from === t.to || seen.has(key) || !ids.has(t.from) || !ids.has(t.to)) continue
    seen.add(key)
    out.push({ kind: 'baton', from: t.from, to: t.to, handoffId: t.handoff_id })
  }
  return out
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
  const batonPairs = new Set<string>()
  for (const h of byCreation) {
    const pred = h.predecessor_session_id
    const child = h.child_session_id
    const key = `${pred}\u0000${child}`
    if (
      pred &&
      child &&
      pred !== child &&
      ids.has(pred) &&
      ids.has(child) &&
      !batonPairs.has(key)
    ) {
      batonPairs.add(key)
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

const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position

// Repos de uma lane na ordem do usuário: projeto (home primeiro) → posição do repo.
function laneRepos(
  repoIds: Set<string>,
  sessionsByRepo: Map<string, string[]>,
  input: SessionGraphInput,
  homeProjectId: string | null,
): SessionGraphLaneRepo[] {
  const project = new Map(input.projects.map((p) => [p.id, p]))
  const rank = (projectId: string) =>
    projectId === homeProjectId ? -1 : (project.get(projectId)?.position ?? Infinity)
  return input.repos
    .filter((r) => repoIds.has(r.id))
    .sort((a, b) => rank(a.project_id) - rank(b.project_id) || byPosition(a, b))
    .map((r) => ({
      repoId: r.id,
      label: r.label,
      projectId: r.project_id,
      projectName: project.get(r.project_id)?.name ?? null,
      projectColor: project.get(r.project_id)?.color ?? null,
      sessionIds: sessionsByRepo.get(r.id) ?? [],
    }))
}

function featureLanes(input: SessionGraphInput, nodes: SessionGraphNode[]): SessionGraphLane[] {
  const byFeature = new Map<string, SessionGraphNode[]>()
  for (const n of nodes) {
    if (n.featureId) byFeature.set(n.featureId, [...(byFeature.get(n.featureId) ?? []), n])
  }
  const projects = new Map(input.projects.map((p) => [p.id, p]))
  const registered = new Map<string, Set<string>>()
  for (const fr of input.featureRepos ?? []) {
    registered.set(fr.feature_id, new Set([...(registered.get(fr.feature_id) ?? []), fr.repo_id]))
  }
  // Ordem estável (a atividade muda a cada tick e faria os cards pularem): o foco
  // do usuário primeiro, depois a feature cuja 1ª sessão nasceu antes.
  const firstStart = (members: SessionGraphNode[]) =>
    Math.min(...members.map((m) => m.startedAt ?? 0))
  return (input.features ?? [])
    .filter((f) => byFeature.has(f.id))
    .sort(
      (a, b) =>
        b.pinned - a.pinned ||
        firstStart(byFeature.get(a.id)!) - firstStart(byFeature.get(b.id)!) ||
        a.id.localeCompare(b.id),
    )
    .map((f): SessionGraphLane => {
      const members = byFeature.get(f.id)!
      const sessionsByRepo = new Map<string, string[]>()
      const loose: string[] = []
      for (const n of members) {
        if (n.repoId)
          sessionsByRepo.set(n.repoId, [...(sessionsByRepo.get(n.repoId) ?? []), n.sessionId])
        else loose.push(n.sessionId)
      }
      const repoIds = new Set([...(registered.get(f.id) ?? []), ...sessionsByRepo.keys()])
      const repos = laneRepos(repoIds, sessionsByRepo, input, f.project_id)
      if (loose.length) repos.push({ repoId: null, label: LOOSE_LABEL, sessionIds: loose })
      const home = projects.get(f.project_id)
      return {
        kind: 'feature',
        featureId: f.id,
        projectId: f.project_id,
        projectName: home?.name ?? null,
        name: f.title,
        color: home?.color ?? null,
        pulse: f.pulse,
        status: f.status,
        pinned: !!f.pinned,
        repos,
      }
    })
}

// Topo do mapa: um card por feature (lanes de repo de qualquer projeto) e, pra
// quem não tem feature, "Sem feature · <Projeto>"; avulsas sem feature por último.
function buildLanes(input: SessionGraphInput, nodes: SessionGraphNode[]): SessionGraphLane[] {
  const byRepo = new Map<string, string[]>()
  const loose: string[] = []
  for (const n of nodes) {
    if (n.featureId) continue
    if (n.repoId) byRepo.set(n.repoId, [...(byRepo.get(n.repoId) ?? []), n.sessionId])
    else loose.push(n.sessionId)
  }
  const lanes: SessionGraphLane[] = featureLanes(input, nodes)
  for (const p of [...input.projects].sort(byPosition)) {
    const repoIds = new Set(input.repos.filter((r) => r.project_id === p.id && byRepo.has(r.id)).map((r) => r.id))
    const repos = laneRepos(repoIds, byRepo, input, p.id)
    if (repos.length)
      lanes.push({
        kind: 'project',
        projectId: p.id,
        name: `${NO_FEATURE_PREFIX}${p.name}`,
        color: p.color,
        repos,
      })
  }
  if (loose.length) {
    lanes.push({
      kind: 'project',
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
  const lineage = lineageEdges(input.handoffs, ids, childHandoff)
  return {
    nodes,
    lanes: buildLanes(input, nodes),
    edges: [
      ...lineage,
      ...motherBatonEdges(input.motherTransfers ?? [], ids, lineage),
      ...repoDepEdges(input.repoDependencies, nodes),
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
  const rows = db
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
  return rows.map((h) =>
    h.status === 'interrupted'
      ? { ...h, resumable: isResumableChild(h.status, h.child_session_id) }
      : h,
  )
}

function readMotherTransfers(
  db: Database.Database,
  handoffs: GraphHandoffRow[],
): GraphMotherTransfer[] {
  if (handoffs.length === 0) return []
  const rows = db
    .prepare(
      `SELECT handoff_id, detail, at FROM handoff_events
        WHERE event = 'mother_transferred'
          AND handoff_id IN (SELECT value FROM json_each(?))
        ORDER BY at, rowid`,
    )
    .all(JSON.stringify(handoffs.map((h) => h.id))) as Array<{
    handoff_id: string
    detail: string | null
    at: number
  }>
  return rows.flatMap((r) => {
    try {
      const d = JSON.parse(r.detail ?? '') as { from?: unknown; to?: unknown }
      if (typeof d.from !== 'string' || typeof d.to !== 'string') return []
      return [{ handoff_id: r.handoff_id, from: d.from, to: d.to, at: r.at }]
    } catch {
      return []
    }
  })
}

function readPastTasks(db: Database.Database, sessionIds: string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (sessionIds.length === 0) return out
  const rows = db
    .prepare(
      `SELECT sid, task FROM (
         SELECT child_session_id AS sid, task, created_at FROM handoffs
          WHERE child_session_id IN (SELECT value FROM json_each(?))
         UNION ALL
         SELECT predecessor_session_id AS sid, task, created_at FROM handoffs
          WHERE predecessor_session_id IN (SELECT value FROM json_each(?))
       ) WHERE task IS NOT NULL AND trim(task) <> '' ORDER BY created_at`,
    )
    .all(JSON.stringify(sessionIds), JSON.stringify(sessionIds)) as Array<{
    sid: string
    task: string
  }>
  // ORDER BY created_at: o mais recente sobrescreve.
  for (const r of rows) out.set(r.sid, r.task)
  return out
}

// Nós = sessões vivas + as que os handoffs em vista citam (mãe, filha,
// antecessora do bastão). Uma mãe encerrada continua sendo "de onde a filha saiu".
export function readSessionGraphInput(
  db: Database.Database,
  live: Map<string, LiveSessionState>,
  now = Date.now(),
  // live: sessão viva ainda pode ganhar o 1º prompt (o leitor retenta mais cedo).
  firstPrompt: (ccSessionId: string, live: boolean) => string | null = () => null,
  lastPrompt: (ccSessionId: string, live: boolean) => string | null = () => null,
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
      `SELECT id, repo_id, cc_session_id, title, title_source, provider, feature_id, started_at,
              ended_at, purpose, group_id, last_summary, last_summary_at
         FROM sessions WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .all(ids) as GraphSessionRow[]
  // Filha e antecessora do bastão têm a tarefa do handoff: o transcript não é lido.
  const children = new Set(handoffs.flatMap((h) => [h.child_session_id, h.predecessor_session_id]))
  const pastTasks = readPastTasks(
    db,
    sessions.filter((s) => !s.purpose?.trim() && !children.has(s.id)).map((s) => s.id),
  )
  // Só o claude grava transcript em ~/.claude/projects: codex nem entra na busca.
  const firstPrompts = new Map(
    sessions
      .filter(
        (s) =>
          s.provider === 'claude' &&
          !s.purpose?.trim() &&
          !children.has(s.id) &&
          !pastTasks.has(s.id) &&
          s.cc_session_id,
      )
      .map((s) => [s.id, firstPrompt(s.cc_session_id!, live.has(s.id))] as const),
  )
  // "Onde parei" sem resumo: só quem não tem um ganha a leitura do fim do transcript.
  const lastPrompts = new Map(
    sessions
      .filter((s) => s.provider === 'claude' && !s.last_summary && s.cc_session_id)
      .map((s) => [s.id, lastPrompt(s.cc_session_id!, live.has(s.id))] as const),
  )
  const featureIds = JSON.stringify([
    ...new Set(sessions.map((s) => s.feature_id).filter((id): id is string => !!id)),
  ])
  // Pulso vigente = o mais recente (mesma ordem do loop-store.currentPulse).
  const features = db
    .prepare(
      `SELECT f.id, f.project_id, f.title, f.status, f.pinned,
              (SELECT body FROM feature_pulses p WHERE p.feature_id = f.id
                ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1) AS pulse
         FROM features f
        WHERE f.id IN (SELECT value FROM json_each(?)) AND f.archived_at IS NULL`,
    )
    .all(featureIds) as GraphFeatureRow[]
  const featureRepos = db
    .prepare(
      `SELECT feature_id, repo_id FROM feature_repos
        WHERE feature_id IN (SELECT value FROM json_each(?))`,
    )
    .all(featureIds) as GraphFeatureRepoRow[]

  return {
    sessions,
    handoffs,
    motherTransfers: readMotherTransfers(db, handoffs),
    features,
    featureRepos,
    firstPrompts,
    pastTasks,
    lastPrompts,
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
