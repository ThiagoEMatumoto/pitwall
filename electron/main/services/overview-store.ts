import { getDb } from './db'
import { wakeHealth } from './handoff/handoff-wake'
import * as objectiveStore from './objective-store'
import * as taskStore from './task-store'
import { classifyDue, isPendingStatus, sortPendingTasks } from '../../../shared/pending'
import type {
  FeatureStatus,
  OverviewCounts,
  OverviewData,
  OverviewFeatureActivity,
  OverviewObjectiveNode,
  OverviewPendingTask,
  OverviewTaskParentRef,
  OverviewTaskSummary,
  TaskLink,
  TaskParentType,
  TaskPriority,
  TaskStatus,
} from '../../../shared/types/ipc'

// Agregado do dashboard (Fase 4): monta a árvore objetivos → KRs → tarefas/
// features numa única chamada IPC. Progresso vem dos MESMOS helpers do
// objective-store (list/keyResultProgress/linkedFeatureSummaries) — nada de
// lógica de rollup duplicada aqui.

// ---- Tarefas resumidas por parent ----

interface TaskSummaryRow {
  id: string
  title: string
  status: string
  priority: string | null
  due_date: number | null
}

// Projeção enxuta das tarefas vinculadas a um parent, na ordem canônica de
// task-store.list (position → created_at).
function taskSummaries(parentType: TaskParentType, parentId: string): OverviewTaskSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT t.id, t.title, t.status, t.priority, t.due_date FROM tasks t
       JOIN task_links l ON l.task_id = t.id
       WHERE l.parent_type = ? AND l.parent_id = ?
       ORDER BY t.position ASC, t.created_at ASC`,
    )
    .all(parentType, parentId) as TaskSummaryRow[]
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status as TaskStatus,
    priority: r.priority as TaskPriority | null,
    dueDate: r.due_date,
  }))
}

// ---- Resolução de parents das pendências ----

const PARENT_TABLE: Record<TaskParentType, string> = {
  objective: 'objectives',
  key_result: 'key_results',
  feature: 'features',
}

// Resolve o título do parent de um vínculo. Vínculo órfão (parent deletado
// fora do fluxo normal) → null, e some da lista de parents.
function resolveParent(link: TaskLink): OverviewTaskParentRef | null {
  const row = getDb()
    .prepare(`SELECT title FROM ${PARENT_TABLE[link.parentType]} WHERE id = ?`)
    .get(link.parentId) as { title: string } | undefined
  if (!row) return null
  return { type: link.parentType, id: link.parentId, title: row.title }
}

// ---- Features em andamento (card da Home) ----

interface FeatureActivityRow {
  id: string
  title: string
  status: string
  project_id: string
  last_session_at: number | null
  session_count: number
  objective_link_count: number
}

// Features ativas (in-progress|blocked|paused, não-arquivadas) com a atividade
// real de sessões: última sessão = MAX(COALESCE(ended_at, started_at)) e
// contagem, agregadas só sobre sessions com feature_id (sessões avulsas e sem
// vínculo ficam de fora do GROUP BY). LEFT JOIN: feature sem nenhuma sessão
// aparece com lastSessionAt null e sessionCount 0. objective_link_count (Onda
// 0) espelha a mesma agregação de feature-store.objectiveLinkCounts.
// Features app-dev (Onda 3) ficam fora por default — não são "trabalho" no
// sentido que o card mede, e poluiriam o sinal do "sem OKR".
function featureActivity(): OverviewFeatureActivity[] {
  const rows = getDb()
    .prepare(
      `SELECT f.id, f.title, f.status, f.project_id,
              s.last_session_at, COALESCE(s.session_count, 0) AS session_count,
              COALESCE(l.link_count, 0) AS objective_link_count
       FROM features f
       LEFT JOIN (
         SELECT feature_id,
                MAX(COALESCE(ended_at, started_at)) AS last_session_at,
                COUNT(*) AS session_count
         FROM sessions
         WHERE feature_id IS NOT NULL
         GROUP BY feature_id
       ) s ON s.feature_id = f.id
       LEFT JOIN (
         SELECT feature_id, COUNT(*) AS link_count FROM feature_links GROUP BY feature_id
       ) l ON l.feature_id = f.id
       WHERE f.status IN ('in-progress', 'blocked', 'paused') AND f.archived_at IS NULL
         AND f.is_app_dev = 0
       ORDER BY COALESCE(s.last_session_at, f.updated_at) DESC`,
    )
    .all() as FeatureActivityRow[]
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status as FeatureStatus,
    projectId: r.project_id,
    lastSessionAt: r.last_session_at,
    sessionCount: r.session_count,
    objectiveLinkCount: r.objective_link_count,
  }))
}

// ---- API pública ----

export function getOverview(): OverviewData {
  // list() default já exclui archived → sobram active|paused|done, com
  // progresso calculado pela mesma regra da tela de Objetivos.
  const objectives = objectiveStore.list()

  const nodes = new Map<string, OverviewObjectiveNode>()
  for (const obj of objectives) {
    const { progress, ...objective } = obj
    const keyResults = objectiveStore.loadKeyResults(obj.id)
    nodes.set(obj.id, {
      objective,
      progress,
      keyResults: keyResults.map((kr) => ({
        keyResult: kr,
        progress: objectiveStore.keyResultProgress(kr),
        tasks: taskSummaries('key_result', kr.id),
        linkedFeatures: objectiveStore.linkedFeatureSummaries('key_result', kr.id),
      })),
      directTasks: taskSummaries('objective', obj.id),
      linkedFeatures: objectiveStore.linkedFeatureSummaries('objective', obj.id),
      children: [],
    })
  }

  // Monta a árvore preservando a ordem do list() (updated_at DESC). Filho cujo
  // parent ficou fora do conjunto (ex.: parent arquivado) vira raiz — não some.
  const roots: OverviewObjectiveNode[] = []
  for (const obj of objectives) {
    const node = nodes.get(obj.id)
    if (!node) continue
    const parent = obj.parentObjectiveId ? nodes.get(obj.parentObjectiveId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const now = Date.now()
  const pendingTasks = sortPendingTasks(taskStore.list().filter((t) => isPendingStatus(t.status)))
  const pending: OverviewPendingTask[] = pendingTasks.map((t) => ({
    ...t,
    parents: t.links
      .map(resolveParent)
      .filter((p): p is OverviewTaskParentRef => p !== null),
  }))

  const counts: OverviewCounts = {
    activeObjectives: objectives.filter((o) => o.status === 'active').length,
    pendingTasks: pending.length,
    dueToday: pending.filter((t) => classifyDue(t.dueDate, now) === 'today').length,
    overdue: pending.filter((t) => classifyDue(t.dueDate, now) === 'overdue').length,
  }

  return {
    objectives: roots,
    pending,
    counts,
    features: featureActivity(),
    handoffWake: wakeHealth({}, now),
  }
}
