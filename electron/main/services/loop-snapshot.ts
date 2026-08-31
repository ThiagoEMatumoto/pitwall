import { getDb } from './db'
import {
  issuesOf,
  lastActivityAt,
  livenessOf,
  metricTone,
  type LoopInput,
} from '../../../shared/feature-loop'
import { duplicateSuspectOf, readFocus } from './feature-focus'
import {
  currentPulse,
  listLedger,
  listMetricPoints,
  listMetrics,
} from './loop-store'
import type {
  FeatureLoopSnapshot,
  FeatureMetricColumn,
  FeatureMetricPoint,
  FeatureMetricSeries,
  FeatureStatus,
} from '../../../shared/types/ipc'

// Projeção de leitura do loop: junta o que ./loop-store persistiu e devolve as
// DERIVAÇÕES do módulo puro shared/feature-loop.ts (liveness, issues, tom).
// Separado do store porque a regra "só I/O no store" é o que mantém a
// derivação testável sem banco — e porque juntos os dois passavam de 450 linhas.

function toSeries(
  columns: FeatureMetricColumn[],
  points: FeatureMetricPoint[],
): FeatureMetricSeries[] {
  return columns.map((column) => {
    const own = points.filter((p) => p.columnKey === column.columnKey)
    const latest = own.length > 0 ? own[own.length - 1] : null
    return {
      column,
      points: own,
      latest,
      // Sem valor medido não há o que comparar contra target/floor.
      tone:
        latest === null || latest.value === null
          ? ('neutral' as const)
          : metricTone(latest.value, column),
    }
  })
}

interface FeatureLoopRow {
  status: string
  objective: string | null
  updated_at: number
  completed_at: number | null
  cadence_days: number | null
}

// Suspeita de duplicata: PERSISTIDA (features.duplicate_of, migration 043) e
// lida aqui pra virar dado de entrada do módulo puro. O snapshot devolve o
// candidato inteiro além da issue porque a issue só tem texto — quem vai
// oferecer "mesclar" precisa do id.

/**
 * Tudo que a UI do loop precisa numa leitura só.
 *
 * `docMtime` fica de fora de propósito — statar o `.md` a cada leitura seria
 * I/O de disco no caminho quente, e o watcher da feature já carimba
 * features.updated_at quando o arquivo muda fora do app.
 */
export function loopSnapshot(featureId: string, now: number = Date.now()): FeatureLoopSnapshot {
  const db = getDb()
  const feature = db
    .prepare(
      'SELECT status, objective, updated_at, completed_at, cadence_days FROM features WHERE id = ?',
    )
    .get(featureId) as FeatureLoopRow | undefined
  if (!feature) throw new Error(`feature not found: ${featureId}`)

  const suspect = duplicateSuspectOf(featureId)
  const focus = readFocus(featureId)
  const pulse = currentPulse(featureId)
  const ledger = listLedger(featureId)
  const columns = listMetrics(featureId)
  const points = listMetricPoints(featureId)

  const lastRecordAt = (
    db
      .prepare('SELECT MAX(session_at) AS at FROM feature_session_records WHERE feature_id = ?')
      .get(featureId) as { at: number | null }
  ).at
  const lastLedgerAt = (
    db
      .prepare('SELECT MAX(updated_at) AS at FROM feature_ledger WHERE feature_id = ?')
      .get(featureId) as { at: number | null }
  ).at
  const repos = db
    .prepare('SELECT repo_id FROM feature_repos WHERE feature_id = ?')
    .all(featureId) as Array<{ repo_id: string }>

  const input: LoopInput = {
    status: feature.status as FeatureStatus,
    completedAt: feature.completed_at,
    cadenceDays: feature.cadence_days,
    objective: feature.objective,
    updatedAt: feature.updated_at,
    lastRecordAt,
    lastPulseAt: pulse?.createdAt ?? null,
    lastLedgerAt,
    // points vem ordenado por `at` ASC — o último é o mais recente.
    lastMetricPointAt: points.length > 0 ? points[points.length - 1].at : null,
    pulse: pulse ? { body: pulse.body, source: pulse.source, createdAt: pulse.createdAt } : null,
    ledger: ledger.map((e) => ({ entryId: e.entryId, title: e.title, createdAt: e.createdAt })),
    metrics: columns,
    metricPoints: points,
    repos: repos.map((r) => ({ repoId: r.repo_id })),
    duplicateSuspect: suspect
      ? { featureId: suspect.candidateId, title: suspect.title, score: suspect.score }
      : null,
  }

  return {
    featureId,
    pulse,
    liveness: livenessOf(input, now),
    issues: issuesOf(input),
    ledger,
    metrics: toSeries(columns, points),
    lastActivityAt: lastActivityAt(input),
    pinned: focus.pinned,
    focusRank: focus.focusRank,
    duplicateSuspect: suspect,
  }
}
