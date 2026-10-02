// Resolução CONTÍNUA da feature das sessões vivas (a parte com I/O do
// feature-session-resolver). Roda no mesmo tick que reconstrói o grafo; só
// trabalha numa sessão quando o sinal dela (cwd do session file + branch da
// cauda do transcript + o estado das features/feature_repos) mudou. Escreve sessions.feature_id e avisa por
// 'session:feature-changed' — o mesmo contrato do sessions:set-feature.
import { statSync } from 'node:fs'
import { getDb } from './db'
import { forgetSessionPositions } from './canvas-store'
import { broadcast } from './notify'
import { ptyManager } from './pty-manager'
import { buildSessionsFileIndex, readTailSync } from './session-activity'
import { transcriptIndex } from './transcript-index'
import { readFirstPrompt } from './session-purpose'
import { resolveRepoPath } from './repo-path'
import {
  findFeatureByRepoBranch,
  getProjectIdForRepo,
  isVisibleFeature,
  listActiveFeaturesByProject,
  sessionRecordCount,
} from './feature-store'
import { isDraftFeature } from '../../../shared/feature-visibility'
import type { FeatureOrigin } from '../../../shared/types/ipc'
import { isProtectedBranch } from './feature-heuristics'
import {
  branchFromTail,
  decideContinuous,
  MANUAL_FEATURE_SOURCE,
  matchFuzzy,
  matchWorktree,
  ownedFromSource,
  pickMatch,
  resolverSource,
  type WorktreeRow,
} from './feature-session-resolver'

interface SessionRow {
  id: string
  repo_id: string | null
  cc_session_id: string | null
  feature_id: string | null
  feature_source: string | null
}

// sessions.id → último sinal visto (só um atalho: a origem do vínculo mora em
// sessions.feature_source e sobrevive ao restart).
const lastSignal = new Map<string, string>()
// sessions.id → último cwd/branch LIDO. Leitura que falha (cauda de 64KB sem
// gitBranch depois de um tool_result grande, session file sendo reescrito) não
// é "o sinal sumiu": vale o último valor lido, senão o vínculo pisca.
const lastRead = new Map<string, { cwd: string | null; branch: string | null }>()
const branchCache = new Map<string, { mtime: number; size: number; branch: string | null }>()

type SessionsFileIndex = ReturnType<typeof buildSessionsFileIndex>

function transcriptBranch(ccSessionId: string): string | null {
  // Map.get: o findTranscriptPath varreria ~/.claude/projects por sessão por tick.
  const path = transcriptIndex.lookup(ccSessionId)
  if (!path) return null
  try {
    const st = statSync(path)
    const hit = branchCache.get(path)
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.branch
    const branch = branchFromTail(readTailSync(path))
    branchCache.set(path, { mtime: st.mtimeMs, size: st.size, branch })
    return branch
  } catch {
    return null
  }
}

// Muda quando uma feature é criada/editada/arquivada, quando feature_repos ganha
// branch/worktree ou quando um rascunho vira visível: sem isso uma sessão viva
// com o mesmo cwd/branch nunca seria reavaliada contra a feature nova.
function featuresFingerprint(): string {
  const row = getDb()
    .prepare(
      `SELECT
         (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), 0) || ':' || COUNT(archived_at)
            FROM features) AS f,
         (SELECT COUNT(*) || ':' || COALESCE(group_concat(
                   feature_id || '/' || repo_id || '/' || COALESCE(branch, '') || '/' ||
                   COALESCE(worktree_path, ''), ','), '')
            FROM feature_repos) AS fr,
         (SELECT COUNT(*) FROM feature_session_records) AS rec`,
    )
    .get() as { f: string; fr: string; rec: number }
  return `${row.f}|${row.fr}|${row.rec}`
}

// Rascunho oculto não vira card no mapa: vale para os três sinais.
function visibleFeatureId(featureId: string | null): string | null {
  if (!featureId) return null
  const row = getDb().prepare('SELECT origin FROM features WHERE id = ?').get(featureId) as
    | { origin: FeatureOrigin }
    | undefined
  return row && !isDraftFeature(row.origin, sessionRecordCount(featureId)) ? featureId : null
}

function worktreeRows(): WorktreeRow[] {
  const rows = getDb()
    .prepare(
      `SELECT fr.feature_id, fr.worktree_path, r.path AS repo_path
         FROM feature_repos fr
         JOIN features f ON f.id = fr.feature_id
         JOIN repos r ON r.id = fr.repo_id
        WHERE f.archived_at IS NULL AND fr.worktree_path IS NOT NULL AND trim(fr.worktree_path) <> ''`,
    )
    .all() as Array<{ feature_id: string; worktree_path: string; repo_path: string }>
  return rows.map((r) => ({
    featureId: r.feature_id,
    worktreePath: resolveRepoPath(r.worktree_path),
    repoPath: resolveRepoPath(r.repo_path),
  }))
}

// Projetos cujas features podem conter este repo: o do próprio repo e o de toda
// feature que registrou o repo em feature_repos (feature cross-project).
function candidateFeatures(repoId: string) {
  const own = getProjectIdForRepo(repoId)
  const others = getDb()
    .prepare(
      `SELECT DISTINCT f.project_id FROM features f
         JOIN feature_repos fr ON fr.feature_id = f.id
        WHERE fr.repo_id = ? AND f.archived_at IS NULL`,
    )
    .all(repoId) as Array<{ project_id: string }>
  const projects = new Set([...(own ? [own] : []), ...others.map((r) => r.project_id)])
  return [...projects].flatMap((projectId) =>
    listActiveFeaturesByProject(projectId).filter(
      (f) => projectId === own || f.repos.some((r) => r.repoId === repoId),
    ),
  )
}

// `pending`: havia candidatas mas o 1º prompt ainda não é legível — o sinal
// não pode ser dado como visto, senão o fuzzy nunca mais roda.
function fuzzyFor(row: SessionRow): { featureId: string | null; pending: boolean } {
  const none = { featureId: null, pending: false }
  if (row.feature_id || !row.repo_id || !row.cc_session_id) return none
  const features = candidateFeatures(row.repo_id).filter(isVisibleFeature)
  if (features.length === 0) return none
  const prompt = readFirstPrompt(row.cc_session_id, true)
  return { featureId: matchFuzzy(prompt, features), pending: prompt === null }
}

// `index`: o mesmo índice de session files que o rebuild do grafo já montou.
export function resolveLiveSessionFeatures(index?: SessionsFileIndex): void {
  const running = ptyManager.runningIds()
  const alive = new Set(running)
  for (const id of [...lastSignal.keys()]) if (!alive.has(id)) lastSignal.delete(id)
  for (const id of [...lastRead.keys()]) if (!alive.has(id)) lastRead.delete(id)
  if (running.length === 0) return

  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, repo_id, cc_session_id, feature_id, feature_source FROM sessions
        WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(running)) as SessionRow[]
  const files = index ?? buildSessionsFileIndex()
  let worktrees: WorktreeRow[] | null = null
  const generation = featuresFingerprint()
  const signalOf = (cwd: string | null, branch: string | null, fid: string | null, src: string | null) =>
    [cwd ?? '', branch ?? '', fid ?? '', src ?? '', generation].join('\u0000')

  for (const row of rows) {
    const known = lastRead.get(row.id)
    const readCwd = row.cc_session_id ? (files.get(row.cc_session_id)?.cwd ?? null) : null
    const readBranch = row.cc_session_id ? transcriptBranch(row.cc_session_id) : null
    const cwd = readCwd ?? known?.cwd ?? null
    const branch = readBranch ?? known?.branch ?? null
    lastRead.set(row.id, { cwd, branch })
    const signal = signalOf(cwd, branch, row.feature_id, row.feature_source)
    if (lastSignal.get(row.id) === signal) continue
    lastSignal.set(row.id, signal)

    worktrees ??= worktreeRows()
    const byBranch =
      row.repo_id && branch && !isProtectedBranch(branch)
        ? visibleFeatureId(findFeatureByRepoBranch(row.repo_id, branch)?.id ?? null)
        : null
    const byWorktree = visibleFeatureId(matchWorktree(cwd, worktrees))
    const fuzzy = byBranch || byWorktree ? null : fuzzyFor(row)
    const match = pickMatch({ byWorktree, byBranch, byFuzzy: fuzzy?.featureId ?? null })
    if (!match && fuzzy?.pending) lastSignal.delete(row.id)
    const decision = decideContinuous({
      current: row.feature_id,
      owned: ownedFromSource(row.feature_id, row.feature_source),
      manual: row.feature_source === MANUAL_FEATURE_SOURCE,
      match,
    })
    if (decision.action === 'keep') continue
    const source = decision.featureId && match ? resolverSource(match.by) : null
    db.prepare('UPDATE sessions SET feature_id = ?, feature_source = ? WHERE id = ?').run(
      decision.featureId,
      source,
      row.id,
    )
    lastSignal.set(row.id, signalOf(cwd, branch, decision.featureId, source))
    console.log(
      `[feature-resolver] session ${row.id} -> ${decision.featureId ?? 'sem feature'} (${match?.by ?? 'sinal sumiu'})`,
    )
    forgetSessionPositions(row.id)
    broadcast('session:feature-changed', { sessionId: row.id, featureId: decision.featureId })
    broadcast('canvas:updated', { scope: null })
  }
}
