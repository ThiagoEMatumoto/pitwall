import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type {
  BranchPullOutcome,
  LastPullRun,
  PullRepoResult,
  RepoPullStatus,
} from '../../../shared/types/ipc'

// Store de repo_pull_runs (migration 033) — histórico do auto-pull. Escopo
// mínimo: só grava e lista, sem update (uma run é imutável, gravada de uma vez
// já com started/finished). Molde leve de scheduled-job-store (rows snake_case
// ⇄ entidades camelCase).

export type PullRunTrigger = 'auto' | 'manual'

export interface RepoPullRun {
  id: string
  trigger: PullRunTrigger
  startedAt: number
  finishedAt: number
  reposTotal: number
  pulled: number
  skipped: number
  errored: number
  results: PullRepoResult[]
}

export interface RecordPullRunInput {
  trigger: PullRunTrigger
  startedAt: number
  finishedAt: number
  results: PullRepoResult[]
}

export interface ListPullRunsFilter {
  limit?: number
}

interface RepoPullRunRow {
  id: string
  trigger: string
  started_at: number
  finished_at: number
  repos_total: number
  pulled: number
  skipped: number
  errored: number
  results_json: string
}

function rowToRun(row: RepoPullRunRow): RepoPullRun {
  return {
    id: row.id,
    trigger: row.trigger as PullRunTrigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    reposTotal: row.repos_total,
    pulled: row.pulled,
    skipped: row.skipped,
    errored: row.errored,
    results: JSON.parse(row.results_json) as PullRepoResult[],
  }
}

// Agrega contagens por status a partir dos resultados e persiste um snapshot
// completo (branches por-repo incluso) — dá visibilidade a "está funcionando?"
// sem precisar reprocessar nada depois.
export function recordPullRun(input: RecordPullRunInput): RepoPullRun {
  const run: RepoPullRun = {
    id: randomUUID(),
    trigger: input.trigger,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    reposTotal: input.results.length,
    pulled: input.results.filter((r) => r.status === 'pulled').length,
    skipped: input.results.filter((r) => r.status === 'skipped').length,
    errored: input.results.filter((r) => r.status === 'error').length,
    results: input.results,
  }
  getDb()
    .prepare(
      `INSERT INTO repo_pull_runs
         (id, trigger, started_at, finished_at, repos_total, pulled, skipped, errored, results_json)
       VALUES (@id, @trigger, @started_at, @finished_at, @repos_total, @pulled, @skipped, @errored, @results_json)`,
    )
    .run({
      id: run.id,
      trigger: run.trigger,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      repos_total: run.reposTotal,
      pulled: run.pulled,
      skipped: run.skipped,
      errored: run.errored,
      results_json: JSON.stringify(run.results),
    })
  return run
}

export function listPullRuns(filter?: ListPullRunsFilter): RepoPullRun[] {
  const limit = filter?.limit && filter.limit > 0 ? Math.floor(filter.limit) : 20
  const rows = getDb()
    .prepare(`SELECT * FROM repo_pull_runs ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as RepoPullRunRow[]
  return rows.map(rowToRun)
}

// Branch mais atrasada do repo — a que mais dói, e cujo `detail` explica por que
// o atraso não zerou (dirty / diverged / checked-out-elsewhere).
function worstBranch(result: PullRepoResult): BranchPullOutcome | undefined {
  let worst: BranchPullOutcome | undefined
  for (const b of result.branches ?? []) {
    if (typeof b.behind !== 'number') continue
    if (worst === undefined || b.behind > (worst.behind ?? 0)) worst = b
  }
  return worst
}

// Recorte da última run pra UI: só o que a sidebar precisa por repo (status +
// pior atraso entre as branches + motivo). Reusa listPullRuns — a run já guarda
// o snapshot completo, não há query nova.
export function getLastPullRun(): LastPullRun | null {
  const [run] = listPullRuns({ limit: 1 })
  if (!run) return null
  const repos: RepoPullStatus[] = run.results.map((r) => {
    const worst = worstBranch(r)
    return { repoId: r.repoId, status: r.status, behind: worst?.behind, reason: worst?.detail }
  })
  return { finishedAt: run.finishedAt, trigger: run.trigger, repos }
}
