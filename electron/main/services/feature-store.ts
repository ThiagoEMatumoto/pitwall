import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import chokidar, { FSWatcher } from 'chokidar'
import { getDb } from './db'
import { isDraftFeature } from '../../../shared/feature-visibility'
import type {
  Feature,
  FeatureLinkTargetType,
  FeatureObjectiveLink,
  FeatureOrigin,
  FeatureRepoLink,
  FeatureStatus,
  FeatureSynthMode,
  FeatureWithStats,
  CreateFeatureInput,
  UpdateFeatureInput,
} from '../../../shared/types/ipc'

// Paths próprios escritos pela síntese/CRUD são registrados aqui ANTES da escrita
// para que o watcher os ignore (evita loop watcher↔re-index). A síntese autônoma
// (fase 8) usa markSelfWrite() antes de cada writeFileSync.
export const pendingSelfWrites = new Set<string>()

export function markSelfWrite(path: string): void {
  pendingSelfWrites.add(path)
}

export function featuresRoot(): string {
  return join(app.getPath('userData'), 'features')
}

function projectDir(projectId: string): string {
  return join(featuresRoot(), projectId)
}

function docPathFor(projectId: string, slug: string): string {
  return join(projectDir(projectId), `${slug}.md`)
}

// ---- slug ----

function slugify(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // tira acentos
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'feature'
  )
}

// Slug único por projeto: anexa -2, -3... se já existir uma row com o mesmo slug.
function uniqueSlug(projectId: string, title: string): string {
  const base = slugify(title)
  const db = getDb()
  const exists = db.prepare('SELECT 1 FROM features WHERE project_id = ? AND slug = ?')
  let candidate = base
  let n = 2
  while (exists.get(projectId, candidate)) {
    candidate = `${base}-${n++}`
  }
  return candidate
}

// ---- frontmatter <-> Feature ----

interface Frontmatter {
  id: string
  slug: string
  title: string
  status: FeatureStatus
  project_id: string
  objective: string | null
  created: number
  last_updated: number
  completed: number | null
  repos: Array<{ repo_id: string; branch: string | null; worktree_path: string | null }>
  synth_mode: FeatureSynthMode
  model: string | null
}

// Estrutura enxuta: 5 seções coesas, TODAS editáveis pela síntese holística
// (Stage 2). Acaba com os headers sempre-vazios e o "preserve freeze" do design
// antigo (8 seções, metade nunca preenchida).
export const SECTIONS = [
  'Visão geral',
  'Estado atual',
  'Decisões',
  'Pontos em aberto',
  'Linha do tempo',
] as const

function skeletonBody(seed: { overview?: string; businessRules?: string; approach?: string }): string {
  // Os seeds opcionais do create (objetivo/regras/abordagem) entram todos na
  // "Visão geral"; a síntese holística reescreve o corpo depois.
  const overviewParts = [seed.overview?.trim(), seed.businessRules?.trim(), seed.approach?.trim()]
    .filter(Boolean)
    .join('\n\n')
  const map: Record<string, string> = { 'Visão geral': overviewParts }
  return (
    SECTIONS.map((h) => {
      const content = map[h] ?? ''
      return `## ${h}\n\n${content}`.trimEnd() + '\n'
    }).join('\n') + '\n'
  )
}

function toFrontmatter(f: Feature): Frontmatter {
  return {
    id: f.id,
    slug: f.slug,
    title: f.title,
    status: f.status,
    project_id: f.projectId,
    objective: f.objective,
    created: f.createdAt,
    last_updated: f.updatedAt,
    completed: f.completedAt,
    repos: f.repos.map((r) => ({
      repo_id: r.repoId,
      branch: r.branch,
      worktree_path: r.worktreePath,
    })),
    synth_mode: f.synthMode,
    model: f.model,
  }
}

function fromFrontmatter(fm: Partial<Frontmatter>, docPath: string, body: string): Feature | null {
  if (!fm.id || !fm.project_id || !fm.slug || !fm.title || !fm.status) return null
  const repos: FeatureRepoLink[] = Array.isArray(fm.repos)
    ? fm.repos
        .filter((r) => r && typeof r.repo_id === 'string')
        .map((r) => ({
          repoId: r.repo_id,
          branch: r.branch ?? null,
          worktreePath: r.worktree_path ?? null,
        }))
    : []
  return {
    id: fm.id,
    projectId: fm.project_id,
    slug: fm.slug,
    title: fm.title,
    status: fm.status,
    objective: fm.objective ?? null,
    docPath,
    synthMode: fm.synth_mode ?? 'threshold',
    model: fm.model ?? null,
    repos,
    createdAt: typeof fm.created === 'number' ? fm.created : Date.now(),
    updatedAt: typeof fm.last_updated === 'number' ? fm.last_updated : Date.now(),
    completedAt: typeof fm.completed === 'number' ? fm.completed : null,
    archivedAt: null, // archive vive só no SQLite, não no frontmatter
    origin: 'manual', // idem: origin vive só no SQLite (reindex preserva o valor da row)
    objectiveLinkCount: 0, // idem: vem de feature_links, reindexFromFile sobrescreve com o valor real
    isAppDev: false, // idem: is_app_dev vive só no SQLite, reindexFromFile preserva o valor real
    // idem pin/suspeita: o upsert do índice não cita essas colunas, então o
    // reindex do watcher NÃO derruba o que o usuário fixou.
    pinned: false,
    focusRank: null,
    duplicateOf: null,
    duplicateScore: null,
    body,
  }
}

// Serializa Feature+corpo no `.md` com self-write guard (o watcher ignora a escrita).
function writeDoc(f: Feature, body: string): void {
  const dir = projectDir(f.projectId)
  mkdirSync(dir, { recursive: true })
  const content = matter.stringify(body, toFrontmatter(f))
  markSelfWrite(f.docPath)
  writeFileSync(f.docPath, content, 'utf8')
}

function readDoc(docPath: string): { feature: Feature; body: string } | null {
  let raw: string
  try {
    raw = readFileSync(docPath, 'utf8')
  } catch {
    return null
  }
  const parsed = matter(raw)
  const feature = fromFrontmatter(parsed.data as Partial<Frontmatter>, docPath, parsed.content)
  if (!feature) return null
  return { feature, body: parsed.content }
}

// ---- SQLite index ----

interface FeatureRow {
  id: string
  project_id: string
  slug: string
  title: string
  status: string
  objective: string | null
  doc_path: string
  synth_mode: string
  model: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
  archived_at: number | null
  origin: string
  is_app_dev: number
  pinned: number
  focus_rank: number | null
  duplicate_of: string | null
  duplicate_score: number | null
}

function rowToFeature(
  row: FeatureRow,
  repos: FeatureRepoLink[],
  objectiveLinkCount: number,
  body?: string,
): Feature {
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.slug,
    title: row.title,
    status: row.status as FeatureStatus,
    objective: row.objective,
    docPath: row.doc_path,
    synthMode: row.synth_mode as FeatureSynthMode,
    model: row.model,
    repos,
    origin: row.origin as FeatureOrigin,
    objectiveLinkCount,
    isAppDev: !!row.is_app_dev,
    // Foco e suspeita vivem só no SQLite (como origin/archived_at): quem
    // ESCREVE é services/feature-focus.ts; aqui a row só é projetada.
    pinned: !!row.pinned,
    focusRank: row.focus_rank,
    duplicateOf: row.duplicate_of,
    duplicateScore: row.duplicate_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    archivedAt: row.archived_at,
    body,
  }
}

function loadRepos(featureId: string): FeatureRepoLink[] {
  const rows = getDb()
    .prepare('SELECT repo_id, branch, worktree_path FROM feature_repos WHERE feature_id = ?')
    .all(featureId) as Array<{ repo_id: string; branch: string | null; worktree_path: string | null }>
  return rows.map((r) => ({ repoId: r.repo_id, branch: r.branch, worktreePath: r.worktree_path }))
}

// ---- Vínculos a objetivos/KRs: contagem (Onda 0) ----
// Dado que faltava em toda projeção (achado-raiz: "ninguém expõe quantas
// features não têm OKR") — causa raiz da sub-linkagem.

// Uso pontual (get/findFeatureByRepoBranch): 1 SELECT por feature.
function objectiveLinkCountOf(featureId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM feature_links WHERE feature_id = ?')
    .get(featureId) as { n: number }
  return row.n
}

// Batch (mesmo padrão de sessionCounts/recordStats): featureId -> count de
// feature_links num único GROUP BY, pra listagens não caírem em N+1.
function objectiveLinkCounts(): Map<string, number> {
  const rows = getDb()
    .prepare('SELECT feature_id, COUNT(*) AS n FROM feature_links GROUP BY feature_id')
    .all() as Array<{ feature_id: string; n: number }>
  return new Map(rows.map((r) => [r.feature_id, r.n]))
}

function writeRepos(featureId: string, repos: FeatureRepoLink[]): void {
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM feature_repos WHERE feature_id = ?').run(featureId)
    const ins = db.prepare(
      'INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path) VALUES (?, ?, ?, ?)',
    )
    for (const r of repos) ins.run(featureId, r.repoId, r.branch, r.worktreePath)
  })
  tx()
}

// Upsert da row + feature_repos a partir de um Feature derivado do frontmatter.
function upsertIndex(f: Feature): void {
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO features
         (id, project_id, slug, title, status, objective, doc_path,
          synth_mode, model, created_at, updated_at, completed_at, archived_at, origin, is_app_dev)
       VALUES (@id, @project_id, @slug, @title, @status, @objective, @doc_path,
               @synth_mode, @model, @created_at, @updated_at, @completed_at, @archived_at, @origin, @is_app_dev)
       ON CONFLICT(id) DO UPDATE SET
         project_id  = excluded.project_id,
         slug        = excluded.slug,
         title       = excluded.title,
         status      = excluded.status,
         objective   = excluded.objective,
         doc_path    = excluded.doc_path,
         synth_mode  = excluded.synth_mode,
         model       = excluded.model,
         updated_at  = excluded.updated_at,
         completed_at = excluded.completed_at`,
    ).run({
      id: f.id,
      project_id: f.projectId,
      slug: f.slug,
      title: f.title,
      status: f.status,
      objective: f.objective,
      doc_path: f.docPath,
      synth_mode: f.synthMode,
      model: f.model,
      created_at: f.createdAt,
      updated_at: f.updatedAt,
      completed_at: f.completedAt,
      // archived_at, origin e is_app_dev não vêm do frontmatter; todos são
      // omitidos do DO UPDATE — a row existente preserva os valores
      // (inseridos só no INSERT).
      archived_at: f.archivedAt,
      origin: f.origin,
      is_app_dev: f.isAppDev ? 1 : 0,
    })
    db.prepare('DELETE FROM feature_repos WHERE feature_id = ?').run(f.id)
    const ins = db.prepare(
      'INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path) VALUES (?, ?, ?, ?)',
    )
    for (const r of f.repos) ins.run(f.id, r.repoId, r.branch, r.worktreePath)
  })
  tx()
}

// ---- API pública ----

export function create(input: CreateFeatureInput): Feature {
  const now = Date.now()
  const slug = uniqueSlug(input.projectId, input.title)
  const id = randomUUID()
  const feature: Feature = {
    id,
    projectId: input.projectId,
    slug,
    title: input.title.trim(),
    status: input.status ?? 'pending',
    objective: input.objective?.trim() ? input.objective.trim() : null,
    docPath: docPathFor(input.projectId, slug),
    synthMode: input.synthMode ?? 'threshold',
    model: input.model ?? null,
    repos: input.repos ?? [],
    origin: input.origin ?? 'manual',
    objectiveLinkCount: 0, // feature nova: links são gravados depois via setObjectiveLinks
    pinned: false, // nasce solta na parede; o pin é gesto humano (feature-focus)
    focusRank: null,
    duplicateOf: null,
    duplicateScore: null,
    isAppDev: input.isAppDev ?? false,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    archivedAt: null,
  }
  const body = skeletonBody({
    overview: input.overview,
    businessRules: input.businessRules,
    approach: input.approach,
  })
  writeDoc(feature, body)
  upsertIndex(feature)
  return { ...feature, body }
}

interface ListOpts {
  projectId?: string
  includeArchived?: boolean
  includeDrafts?: boolean
}

// Carrega as rows do índice. Por padrão exclui arquivadas (archived_at IS NULL)
// E rascunhos (origin='auto' sem nenhum session record) — a visibilidade do
// rascunho é derivada por query, sem flag mutável: o 1º saveSessionRecord()
// torna a feature visível sozinha. includeArchived traz as arquivadas (coluna
// "archived" do board); includeDrafts traz os rascunhos (filtro da sidebar e
// resolução de sessões — sessões novas devem linkar no draft, não duplicar).
function listRows(opts: ListOpts): FeatureRow[] {
  const db = getDb()
  const where: string[] = []
  const params: unknown[] = []
  if (opts.projectId) {
    where.push('project_id = ?')
    params.push(opts.projectId)
  }
  if (!opts.includeArchived) {
    where.push('archived_at IS NULL')
  }
  if (!opts.includeDrafts) {
    where.push(
      `NOT (origin = 'auto' AND id NOT IN (SELECT feature_id FROM feature_session_records))`,
    )
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  return db
    .prepare(`SELECT * FROM features ${clause} ORDER BY updated_at DESC`)
    .all(...params) as FeatureRow[]
}

export function list(projectId?: string): Feature[] {
  const linkCounts = objectiveLinkCounts()
  return listRows({ projectId }).map((row) =>
    rowToFeature(row, loadRepos(row.id), linkCounts.get(row.id) ?? 0),
  )
}

// Agrega a contagem de sessões ligadas (sessions.feature_id) num único GROUP BY,
// evitando N+1. Retorna o mapa featureId -> count.
function sessionCounts(): Map<string, number> {
  const rows = getDb()
    .prepare(
      'SELECT feature_id, COUNT(*) AS n FROM sessions WHERE feature_id IS NOT NULL GROUP BY feature_id',
    )
    .all() as Array<{ feature_id: string; n: number }>
  return new Map(rows.map((r) => [r.feature_id, r.n]))
}

// Agrega contagem e última atividade dos session records num único GROUP BY
// (mesmo padrão de sessionCounts). featureId -> { count, last }.
function recordStats(): Map<string, { count: number; last: number }> {
  const rows = getDb()
    .prepare(
      `SELECT feature_id, COUNT(*) AS n, MAX(session_at) AS last
         FROM feature_session_records GROUP BY feature_id`,
    )
    .all() as Array<{ feature_id: string; n: number; last: number }>
  return new Map(rows.map((r) => [r.feature_id, { count: r.n, last: r.last }]))
}

// list() enriquecido com stats reais (sessões + registros). includeArchived
// traz as arquivadas (coluna do board); includeDrafts traz os rascunhos
// (filtro "Rascunhos" da sidebar). Ordenação por atividade REAL: o registro
// de sessão mais recente quando existe, senão o updated_at do índice.
export function listWithStats(opts?: {
  includeArchived?: boolean
  includeDrafts?: boolean
}): FeatureWithStats[] {
  const counts = sessionCounts()
  const records = recordStats()
  const linkCounts = objectiveLinkCounts()
  return listRows({ includeArchived: opts?.includeArchived, includeDrafts: opts?.includeDrafts })
    .map((row) => ({
      ...rowToFeature(row, loadRepos(row.id), linkCounts.get(row.id) ?? 0),
      sessionCount: counts.get(row.id) ?? 0,
      recordCount: records.get(row.id)?.count ?? 0,
      lastRecordAt: records.get(row.id)?.last ?? null,
    }))
    .sort((a, b) => (b.lastRecordAt ?? b.updatedAt) - (a.lastRecordAt ?? a.updatedAt))
}

export function get(id: string): Feature | null {
  const row = getDb().prepare('SELECT * FROM features WHERE id = ?').get(id) as FeatureRow | undefined
  if (!row) return null
  // Corpo vem do `.md` (fonte de verdade); cai pra string vazia se o arquivo sumiu.
  const doc = readDoc(row.doc_path)
  return rowToFeature(row, loadRepos(row.id), objectiveLinkCountOf(row.id), doc?.body ?? '')
}

// ---- Helpers de resolução (auto-vínculo de sessões a features, fase 8) ----

// Resolve o project_id de um repo. Retorna null se o repo não existe.
export function getProjectIdForRepo(repoId: string): string | null {
  const row = getDb().prepare('SELECT project_id FROM repos WHERE id = ?').get(repoId) as
    | { project_id: string }
    | undefined
  return row?.project_id ?? null
}

// Resolve o path em disco de um repo (usado como worktree_path default na auto-criação).
export function getRepoPath(repoId: string): string | null {
  const row = getDb().prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as
    | { path: string }
    | undefined
  return row?.path ?? null
}

// Acha a feature NÃO-arquivada cujo feature_repos casa (repo_id, branch).
// Dedup natural: sessões repetidas na mesma branch caem na mesma feature.
// INCLUI rascunhos de propósito (query direta, sem o predicado de draft de
// listRows): a sessão nova deve linkar no draft existente, não duplicá-lo.
export function findFeatureByRepoBranch(repoId: string, branch: string): Feature | null {
  const row = getDb()
    .prepare(
      `SELECT f.* FROM features f
         JOIN feature_repos fr ON fr.feature_id = f.id
        WHERE fr.repo_id = ? AND fr.branch = ? AND f.archived_at IS NULL
        ORDER BY f.updated_at DESC
        LIMIT 1`,
    )
    .get(repoId, branch) as FeatureRow | undefined
  if (!row) return null
  return rowToFeature(row, loadRepos(row.id), objectiveLinkCountOf(row.id))
}

// Features NÃO-arquivadas de um projeto (sem corpo). INCLUI rascunhos: o fuzzy
// match da resolução de sessões precisa enxergá-los pra linkar em vez de duplicar.
export function listActiveFeaturesByProject(projectId: string): Feature[] {
  const linkCounts = objectiveLinkCounts()
  return listRows({ projectId, includeDrafts: true }).map((row) =>
    rowToFeature(row, loadRepos(row.id), linkCounts.get(row.id) ?? 0),
  )
}

// Quantos session records a feature tem (entrada do predicado de rascunho).
export function sessionRecordCount(featureId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM feature_session_records WHERE feature_id = ?')
    .get(featureId) as { n: number }
  return row.n
}

// Gate de broadcast: rascunho invisível não deve ir pro renderer (o
// featuresStore.onUpdated insere qualquer Feature broadcastada na lista).
export function isVisibleFeature(f: Feature): boolean {
  return !isDraftFeature(f.origin, sessionRecordCount(f.id))
}

// ---- Registros de sessão (Stage 1 do two-stage) ----

export interface SessionRecord {
  sessionId: string
  featureId: string
  ccSessionId: string | null
  summary: string
  model: string | null
  // Quando a sessão realmente rodou (sessions.started_at) — data da "Linha do tempo".
  sessionAt: number
  createdAt: number
}

// Upsert idempotente: re-sintetizar a mesma sessão substitui o registro. `session_at`
// vem de sessions.started_at (data real do trabalho), não do horário da síntese.
export function saveSessionRecord(rec: Omit<SessionRecord, 'createdAt' | 'sessionAt'>): void {
  const db = getDb()
  const now = Date.now()
  const srow = db.prepare('SELECT started_at FROM sessions WHERE id = ?').get(rec.sessionId) as
    | { started_at: number | null }
    | undefined
  const sessionAt = srow?.started_at ?? now
  db.prepare(
    `INSERT INTO feature_session_records (session_id, feature_id, cc_session_id, summary, model, session_at, created_at)
     VALUES (@session_id, @feature_id, @cc_session_id, @summary, @model, @session_at, @created_at)
     ON CONFLICT(session_id) DO UPDATE SET
       feature_id = excluded.feature_id,
       cc_session_id = excluded.cc_session_id,
       summary = excluded.summary,
       model = excluded.model,
       session_at = excluded.session_at,
       created_at = excluded.created_at`,
  ).run({
    session_id: rec.sessionId,
    feature_id: rec.featureId,
    cc_session_id: rec.ccSessionId,
    summary: rec.summary,
    model: rec.model,
    session_at: sessionAt,
    created_at: now,
  })
}

// Todos os registros de uma feature, em ordem cronológica REAL da sessão (entrada
// do Stage 2). Ordena por session_at; created_at é desempate determinístico.
export function listSessionRecords(featureId: string): SessionRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT session_id, feature_id, cc_session_id, summary, model, session_at, created_at
         FROM feature_session_records WHERE feature_id = ?
        ORDER BY session_at ASC, created_at ASC`,
    )
    .all(featureId) as Array<{
    session_id: string
    feature_id: string
    cc_session_id: string | null
    summary: string
    model: string | null
    session_at: number
    created_at: number
  }>
  return rows.map((r) => ({
    sessionId: r.session_id,
    featureId: r.feature_id,
    ccSessionId: r.cc_session_id,
    summary: r.summary,
    model: r.model,
    sessionAt: r.session_at,
    createdAt: r.created_at,
  }))
}

export function hasSessionRecord(sessionId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM feature_session_records WHERE session_id = ?')
    .get(sessionId)
  return !!row
}

export function update(input: UpdateFeatureInput): Feature {
  const current = get(input.id)
  if (!current) throw new Error(`feature not found: ${input.id}`)

  const status = input.status ?? current.status
  const next: Feature = {
    ...current,
    title: input.title?.trim() || current.title,
    status,
    objective:
      input.objective === undefined
        ? current.objective
        : input.objective?.trim()
          ? input.objective.trim()
          : null,
    synthMode: input.synthMode ?? current.synthMode,
    model: input.model === undefined ? current.model : input.model,
    updatedAt: Date.now(),
    completedAt:
      status === 'done' ? (current.completedAt ?? Date.now()) : current.completedAt,
  }
  writeDoc(next, current.body ?? '')
  upsertIndex(next)
  return next
}

export function archive(id: string): void {
  const now = Date.now()
  getDb().prepare('UPDATE features SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
}

// Estampa/limpa a tag app-dev (Onda 3 — separação app-dev). Sem bump de
// updated_at de propósito: é uma correção de metadado, não uma mudança de
// atividade — não deve "subir" a feature nas listagens ordenadas por atividade.
export function setAppDev(id: string, value: boolean): void {
  getDb().prepare('UPDATE features SET is_app_dev = ? WHERE id = ?').run(value ? 1 : 0, id)
}

// ---- Vínculos Feature → Objetivo/KR (Fase 3) ----

// feature_links é polimórfico (sem FK em target_id), espelho de task_links:
// o CASCADE de features→feature_links cobre o delete da feature; órfãos por
// target são limpos pelo dono do target (deleteKeyResult em objective-store).

export function listObjectiveLinks(featureId: string): FeatureObjectiveLink[] {
  const rows = getDb()
    .prepare(
      `SELECT target_type, target_id FROM feature_links
        WHERE feature_id = ? ORDER BY target_type ASC, target_id ASC`,
    )
    .all(featureId) as Array<{ target_type: string; target_id: string }>
  return rows.map((r) => ({
    targetType: r.target_type as FeatureLinkTargetType,
    targetId: r.target_id,
  }))
}

// Títulos dos OKRs que a feature serve (Onda 2 — contexto injetado no spawn):
// objetivo direto OU o objetivo dono do KR, quando o vínculo é a um KR. Query
// direta em objectives/key_results (sem importar objective-store — mesmo
// padrão de linkedFeatureRows em objective-store.ts, que também consulta
// `features` direto pra evitar import circular).
export function linkedObjectiveTitles(featureId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT o.title FROM feature_links l
         JOIN objectives o ON o.id = l.target_id
        WHERE l.feature_id = ? AND l.target_type = 'objective'
       UNION
       SELECT o.title FROM feature_links l
         JOIN key_results kr ON kr.id = l.target_id
         JOIN objectives o ON o.id = kr.objective_id
        WHERE l.feature_id = ? AND l.target_type = 'key_result'`,
    )
    .all(featureId, featureId) as Array<{ title: string }>
  return rows.map((r) => r.title)
}

// Tabela dona de cada FeatureLinkTargetType — usada pra validar existência do
// alvo antes de gravar (feature_links é polimórfico, sem FK em target_id).
const LINK_TARGET_TABLE: Record<FeatureLinkTargetType, string> = {
  objective: 'objectives',
  key_result: 'key_results',
}

// Substitui o conjunto de vínculos (replace-all em transação); retorna os
// links anteriores pra que o IPC notifique também os objetivos que perderam
// a feature. Bumpa updated_at (espelha setLinks de task-store). Valida que
// cada alvo existe antes de gravar — mata órfãos por id alucinado.
export function setObjectiveLinks(
  featureId: string,
  links: FeatureObjectiveLink[],
): FeatureObjectiveLink[] {
  const previous = listObjectiveLinks(featureId)
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM feature_links WHERE feature_id = ?').run(featureId)
    const ins = db.prepare(
      'INSERT OR IGNORE INTO feature_links (feature_id, target_type, target_id) VALUES (?, ?, ?)',
    )
    for (const link of links) {
      const target = db
        .prepare(`SELECT 1 FROM ${LINK_TARGET_TABLE[link.targetType]} WHERE id = ?`)
        .get(link.targetId)
      if (!target) {
        throw new Error(
          `cannot link feature ${featureId} to ${link.targetType} ${link.targetId}: target not found`,
        )
      }
      ins.run(featureId, link.targetType, link.targetId)
    }
    db.prepare('UPDATE features SET updated_at = ? WHERE id = ?').run(Date.now(), featureId)
  })
  tx()
  return previous
}

export function setRepos(id: string, repos: FeatureRepoLink[]): Feature {
  const current = get(id)
  if (!current) throw new Error(`feature not found: ${id}`)
  const next: Feature = { ...current, repos, updatedAt: Date.now() }
  writeRepos(id, repos)
  getDb().prepare('UPDATE features SET updated_at = ? WHERE id = ?').run(next.updatedAt, id)
  writeDoc(next, current.body ?? '')
  return next
}

// Re-parseia o frontmatter de um `.md` e faz upsert em features/feature_repos.
// Usado pelo watcher quando o arquivo muda por fora do app. Retorna o Feature
// re-indexado (ou null se o arquivo for inválido). Em unlink, archiva a row.
export function reindexFromFile(path: string): Feature | null {
  if (!existsSync(path)) {
    // arquivo removido: tenta achar a row pelo doc_path e archivar
    const row = getDb().prepare('SELECT id FROM features WHERE doc_path = ?').get(path) as
      | { id: string }
      | undefined
    if (row) archive(row.id)
    return null
  }
  const doc = readDoc(path)
  if (!doc) return null
  // preserva archived_at, origin e is_app_dev existentes (vivem só no SQLite)
  const existing = getDb()
    .prepare('SELECT archived_at, origin, is_app_dev FROM features WHERE id = ?')
    .get(doc.feature.id) as
    | { archived_at: number | null; origin: string; is_app_dev: number }
    | undefined
  const feature: Feature = {
    ...doc.feature,
    archivedAt: existing?.archived_at ?? null,
    origin: (existing?.origin as FeatureOrigin) ?? 'manual',
    isAppDev: !!existing?.is_app_dev,
    objectiveLinkCount: objectiveLinkCountOf(doc.feature.id),
  }
  upsertIndex(feature)
  return feature
}

// ---- Watcher ----

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

const DEBOUNCE_MS = 300

class FeatureWatcher {
  private watcher: FSWatcher | null = null
  private pending = new Set<string>()
  private timer: NodeJS.Timeout | null = null

  start(): void {
    if (this.watcher) return
    const root = featuresRoot()
    mkdirSync(root, { recursive: true })
    // depth:1 cobre <root>/<projectId>/<slug>.md.
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      depth: 1,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    })
    const onPath = (p: string) => {
      if (!p.endsWith('.md')) return
      // Escrita própria (CRUD/síntese): ignora uma vez e consome o marcador.
      if (pendingSelfWrites.has(p)) {
        pendingSelfWrites.delete(p)
        return
      }
      this.pending.add(p)
      this.schedule()
    }
    this.watcher.on('add', onPath)
    this.watcher.on('change', onPath)
    this.watcher.on('unlink', onPath)
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS)
  }

  private flush(): void {
    const paths = [...this.pending]
    this.pending.clear()
    for (const p of paths) {
      try {
        const feature = reindexFromFile(p)
        // Rascunho invisível re-indexado por edição externa NÃO é broadcastado
        // (o renderer inseriria o draft na lista). O índice já foi atualizado.
        if (feature) {
          if (isVisibleFeature(feature)) broadcast('feature:updated', feature)
        } else {
          broadcast('feature:updated', { docPath: p })
        }
      } catch (err) {
        console.error('[feature-watcher] reindex failed:', p, err)
      }
    }
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.watcher) {
      void this.watcher.close()
      this.watcher = null
    }
    this.pending.clear()
  }
}

export const featureWatcher = new FeatureWatcher()

export function startFeatureWatcher(): void {
  featureWatcher.start()
}

export function stopFeatureWatcher(): void {
  featureWatcher.close()
}

// Helper para testes/limpeza: remove o `.md` de uma feature (não usado em runtime).
export function deleteDoc(docPath: string): void {
  try {
    rmSync(docPath)
  } catch {
    // já removido
  }
}
