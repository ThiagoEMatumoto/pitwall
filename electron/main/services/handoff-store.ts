import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type {
  CreateHandoffInput,
  Handoff,
  HandoffMode,
  HandoffOutcome,
  HandoffStatus,
} from '../../../shared/types/ipc'

interface HandoffRow {
  id: string
  mother_session_id: string | null
  target_repo_id: string
  child_session_id: string | null
  feature_id: string | null
  task: string
  context_json: string | null
  composed_prompt: string
  status: string
  mode: string
  current_step: string | null
  step_updated_at: number | null
  pending_question: string | null
  question_asked_at: number | null
  summary: string | null
  error: string | null
  created_at: number
  updated_at: number
  // Instrumentação (migration 026). consumed_at: quando a mãe consumiu o
  // resultado; from_repo_id: repo de origem; outcome: feedback humano.
  consumed_at: number | null
  from_repo_id: string | null
  outcome: string | null
  // Resolvido via LEFT JOIN repos (null se o repo-alvo foi removido).
  target_repo_label: string | null
}

// SELECT base com o label do repo-alvo resolvido. LEFT JOIN: handoff sobrevive à
// remoção do repo (label vira null), mas continua listável.
const SELECT_HANDOFF =
  'SELECT h.*, r.label AS target_repo_label FROM handoffs h LEFT JOIN repos r ON r.id = h.target_repo_id'

function toEntity(row: HandoffRow): Handoff {
  return {
    id: row.id,
    motherSessionId: row.mother_session_id,
    targetRepoId: row.target_repo_id,
    targetRepoLabel: row.target_repo_label,
    childSessionId: row.child_session_id,
    featureId: row.feature_id,
    task: row.task,
    contextJson: row.context_json,
    composedPrompt: row.composed_prompt,
    status: row.status as HandoffStatus,
    mode: row.mode as HandoffMode,
    currentStep: row.current_step,
    stepUpdatedAt: row.step_updated_at,
    pendingQuestion: row.pending_question,
    questionAskedAt: row.question_asked_at,
    summary: row.summary,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    consumedAt: row.consumed_at,
    fromRepoId: row.from_repo_id,
    outcome: (row.outcome as HandoffOutcome | null) ?? null,
  }
}

function getRow(id: string): HandoffRow | undefined {
  return getDb().prepare(`${SELECT_HANDOFF} WHERE h.id = ?`).get(id) as HandoffRow | undefined
}

// Carrega a entidade fresca pós-mutação; lança se sumiu (id inválido).
function fresh(id: string): Handoff {
  const row = getRow(id)
  if (!row) throw new Error(`handoff not found: ${id}`)
  return toEntity(row)
}

// Status corrente sem o JOIN do label — barato pra capturar o from_status ANTES
// de uma mutação. NULL se o handoff não existe (não loga nada nesse caso).
function currentStatus(id: string): string | null {
  const row = getDb().prepare('SELECT status FROM handoffs WHERE id = ?').get(id) as
    | { status: string }
    | undefined
  return row?.status ?? null
}

// Trilha imutável: grava uma linha em handoff_events por transição/evento. É o
// ponto CENTRAL da instrumentação — todos os mutadores de status chamam aqui em
// vez de cada handler logar por conta própria. from_status é o estado ANTES da
// mutação (capturado pelo chamador); to_status é o estado resultante.
function logEvent(
  handoffId: string,
  event: string,
  toStatus: string,
  fromStatus: string | null,
  detail?: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO handoff_events (id, handoff_id, from_status, to_status, event, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), handoffId, fromStatus, toStatus, event, detail ?? null, Date.now())
}

export function create(input: CreateHandoffInput): Handoff {
  const now = Date.now()
  const id = input.id ?? randomUUID()
  getDb()
    .prepare(
      `INSERT INTO handoffs
         (id, mother_session_id, target_repo_id, from_repo_id, child_session_id, feature_id, task,
          context_json, composed_prompt, status, mode, current_step, step_updated_at,
          summary, error, created_at, updated_at)
       VALUES (@id, @mother_session_id, @target_repo_id, @from_repo_id, @child_session_id, @feature_id, @task,
               @context_json, @composed_prompt, @status, @mode, @current_step, @step_updated_at,
               @summary, @error, @created_at, @updated_at)`,
    )
    .run({
      id,
      mother_session_id: input.motherSessionId ?? null,
      target_repo_id: input.targetRepoId,
      from_repo_id: input.fromRepoId ?? null,
      child_session_id: null,
      feature_id: input.featureId ?? null,
      task: input.task,
      context_json: input.contextJson ?? null,
      composed_prompt: input.composedPrompt,
      status: 'pending',
      mode: input.mode ?? 'interactive',
      current_step: null,
      step_updated_at: null,
      summary: null,
      error: null,
      created_at: now,
      updated_at: now,
    })
  // Nascimento do handoff: from_status null (não existia antes), to pending.
  logEvent(id, 'create', 'pending', null)
  // Re-lê via JOIN pra preencher target_repo_label.
  return fresh(id)
}

export function get(id: string): Handoff | null {
  const row = getRow(id)
  return row ? toEntity(row) : null
}

// Nomes já ocupados por sessões VIVAS — base de unicidade do alias da filha (o
// alias vira o `-n <name>` e é espelhado em sessions.title). Colisão de nome faz
// a CLI desambiguar com hex ilegível no ListAgents, então é o que evitamos aqui.
export function activeSessionNames(): string[] {
  const rows = getDb()
    .prepare("SELECT title FROM sessions WHERE status = 'running' AND title IS NOT NULL")
    .all() as { title: string }[]
  return rows.map((r) => r.title)
}

// Alias da filha de um handoff (null se ainda não spawnou ou se a sessão sumiu).
// Fonte da verdade = sessions.title, fixado como 'manual' no spawn.
export function childAlias(childSessionId: string | null): string | null {
  if (!childSessionId) return null
  const row = getDb()
    .prepare('SELECT title FROM sessions WHERE id = ?')
    .get(childSessionId) as { title: string | null } | undefined
  return row?.title ?? null
}

export function list(opts?: { status?: HandoffStatus | HandoffStatus[] }): Handoff[] {
  const db = getDb()
  let rows: HandoffRow[]
  if (opts?.status !== undefined) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status]
    const placeholders = statuses.map(() => '?').join(', ')
    rows = db
      .prepare(
        `${SELECT_HANDOFF} WHERE h.status IN (${placeholders}) ORDER BY h.created_at DESC`,
      )
      .all(...statuses) as HandoffRow[]
  } else {
    rows = db.prepare(`${SELECT_HANDOFF} ORDER BY h.created_at DESC`).all() as HandoffRow[]
  }
  return rows.map(toEntity)
}

// Marca approved. Permite sobrescrever o composed_prompt editado pelo humano no
// gate. A transição para running + child_session_id vem numa wave posterior.
export function approve(id: string, opts: { composedPrompt?: string }): Handoff {
  const db = getDb()
  const from = currentStatus(id)
  if (opts.composedPrompt !== undefined) {
    db.prepare(
      'UPDATE handoffs SET status = ?, composed_prompt = ?, updated_at = ? WHERE id = ?',
    ).run('approved', opts.composedPrompt, Date.now(), id)
  } else {
    db.prepare('UPDATE handoffs SET status = ?, updated_at = ? WHERE id = ?').run(
      'approved',
      Date.now(),
      id,
    )
  }
  logEvent(id, 'approve', 'approved', from)
  return fresh(id)
}

export function reject(id: string): Handoff {
  const from = currentStatus(id)
  getDb()
    .prepare('UPDATE handoffs SET status = ?, updated_at = ? WHERE id = ?')
    .run('rejected', Date.now(), id)
  logEvent(id, 'reject', 'rejected', from)
  return fresh(id)
}

export function markRunning(id: string, childSessionId: string): Handoff {
  const from = currentStatus(id)
  getDb()
    .prepare('UPDATE handoffs SET status = ?, child_session_id = ?, updated_at = ? WHERE id = ?')
    .run('running', childSessionId, Date.now(), id)
  logEvent(id, 'markRunning', 'running', from)
  return fresh(id)
}

export function report(id: string, summary: string): Handoff {
  const from = currentStatus(id)
  // Report duplicado: o handoff já está done. NÃO sobrescreve o summary original
  // (o primeiro resultado é o autoritativo, e é o que a mãe pode já ter consumido)
  // e registra um evento próprio — antes o segundo report passava como sucesso e
  // apagava o primeiro summary sem deixar rastro distinguível.
  if (from === 'done') {
    logEvent(id, 'reportDuplicate', 'done', 'done', summary)
    return fresh(id)
  }
  getDb()
    .prepare('UPDATE handoffs SET status = ?, summary = ?, updated_at = ? WHERE id = ?')
    .run('done', summary, Date.now(), id)
  logEvent(id, 'report', 'done', from)
  return fresh(id)
}

// Progresso NÃO-terminal: a filha reporta o passo atual sem virar done. Grava se
// estiver em estado VIVO (running OU needs_input) e PRESERVA o status — progresso
// NÃO é resposta a pergunta. Uma filha que perguntou e seguiu trabalhando continua
// needs_input com a pergunta intacta (a UI precisa continuar mostrando o bloqueio);
// só a resposta da mãe (resume, via handoff_message ou pelo inbox) encerra a
// pergunta. done segue exclusivo de report.
export function progress(id: string, step: string): Handoff {
  const now = Date.now()
  const from = currentStatus(id)
  const res = getDb()
    .prepare(
      `UPDATE handoffs
         SET current_step = ?, step_updated_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('running','needs_input')`,
    )
    .run(step, now, now, id)
  // Só loga se a transição valeu (estava vivo). to_status = from porque progress
  // não muda status. detail = o passo reportado.
  if (res.changes > 0 && from) logEvent(id, 'progress', from, from, step)
  return fresh(id)
}

// A filha levanta uma pergunta (handoff_ask) e passa pra needs_input, gravando a
// pergunta + timestamp. Aceita running E needs_input: uma segunda pergunta antes
// da resposta é EMPILHADA no mesmo campo (separada por linha em branco) em vez de
// virar no-op invisível — a mãe precisa ver todos os bloqueios abertos, e
// question_asked_at guarda o instante do PRIMEIRO (é o "bloqueada desde"). Empilha
// só a partir de needs_input: em running a pergunta pendente pode ser resíduo de
// um ciclo anterior (ex.: handoff interrompido e retomado). Fora do estado vivo
// (pending/done/...) segue no-op.
export function ask(id: string, question: string): Handoff {
  const now = Date.now()
  const row = getDb()
    .prepare('SELECT status, pending_question, question_asked_at FROM handoffs WHERE id = ?')
    .get(id) as
    | { status: string; pending_question: string | null; question_asked_at: number | null }
    | undefined
  if (!row || (row.status !== 'running' && row.status !== 'needs_input')) return fresh(id)

  const stacked = row.status === 'needs_input' && !!row.pending_question
  getDb()
    .prepare(
      `UPDATE handoffs
         SET status = 'needs_input', pending_question = ?, question_asked_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      stacked ? `${row.pending_question}\n\n${question}` : question,
      stacked ? row.question_asked_at : now,
      now,
      id,
    )
  logEvent(id, 'ask', 'needs_input', row.status, question)
  return fresh(id)
}

// A mãe respondeu (handoff_message) e a filha deve retomar: needs_input → running,
// limpa a pergunta pendente. Só age se estava needs_input (idempotente fora dele).
export function resume(id: string): Handoff {
  const now = Date.now()
  const from = currentStatus(id)
  const res = getDb()
    .prepare(
      `UPDATE handoffs
         SET status = 'running', pending_question = NULL, question_asked_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'needs_input'`,
    )
    .run(now, id)
  if (res.changes > 0) logEvent(id, 'resume', 'running', from)
  return fresh(id)
}

export function fail(id: string, error: string): Handoff {
  const from = currentStatus(id)
  getDb()
    .prepare('UPDATE handoffs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
    .run('failed', error, Date.now(), id)
  logEvent(id, 'fail', 'failed', from, error)
  return fresh(id)
}

// Reconciliação: a sessão-filha morreu (PTY exit/crash). Só transiciona para
// 'interrupted' (estado RECUPERÁVEL, NÃO 'failed') se ainda estava VIVA (running
// OU needs_input) — NÃO sobrescreve um done/rejected já gravado. Uma filha que
// perguntou (needs_input) e cuja PTY morreu de fato também é interrompida (senão
// trava o dedup do repo-alvo pra sempre). 'interrupted' não conta como ativo
// (libera o dedup) e pode ser RETOMADO pelo humano. 'failed' fica reservado a erro REAL reportado
// pela própria filha (handoff_report de falha / fail()).
// Retorna o handoff atualizado, ou null se nada foi alterado (não estava vivo).
export function failIfRunning(id: string, error: string): Handoff | null {
  const from = currentStatus(id)
  const res = getDb()
    .prepare(
      "UPDATE handoffs SET status = 'interrupted', error = ?, updated_at = ? WHERE id = ? AND status IN ('running','needs_input')",
    )
    .run(error, Date.now(), id)
  if (res.changes === 0) return null
  logEvent(id, 'interrupt', 'interrupted', from, error)
  return fresh(id)
}

// Reconciliação em runtime, independente do evento PTY exit: pega filhas
// fechadas/crashadas (ou nunca atreladas) sem esperar o exit. SEGURA por design —
// só interrompe handoffs cuja session-filha NÃO está 'running' na tabela sessions.
// Um filho VIVO em trabalho longo OU aguardando a mãe (needs_input) NÃO pode ser
// morto enquanto a session-filha segue 'running'. Cobre tanto running quanto
// needs_input (ambos in-flight). Marca 'interrupted' (RECUPERÁVEL, não 'failed'):
// a filha morreu sem reportar erro real, então o handoff sai do ativo (libera o
// dedup) mas fica retomável. Como 'interrupted' não entra no predicado
// ('running','needs_input'), passadas seguintes NÃO o re-reconciliam.
// Retorna o nº de handoffs reconciliados.
export function reconcileStuck(): number {
  const db = getDb()
  const error = 'Sessão-filha encerrada sem reportar conclusão'
  // UPDATE em lote: SELECionar os ids + status ANTES, pra capturar o from_status
  // de cada um e logar uma linha por handoff reconciliado (o lote em si não diz
  // quem mudou). O predicado é idêntico ao do UPDATE.
  const stuck = db
    .prepare(
      `SELECT id, status FROM handoffs
       WHERE status IN ('running','needs_input')
         AND (child_session_id IS NULL
              OR child_session_id NOT IN (SELECT id FROM sessions WHERE status = 'running'))`,
    )
    .all() as Array<{ id: string; status: string }>
  const res = db
    .prepare(
      `UPDATE handoffs SET status = 'interrupted', error = ?, updated_at = ?
       WHERE status IN ('running','needs_input')
         AND (child_session_id IS NULL
              OR child_session_id NOT IN (SELECT id FROM sessions WHERE status = 'running'))`,
    )
    .run(error, Date.now())
  for (const h of stuck) {
    logEvent(h.id, 'reconcileStuck', 'interrupted', h.status, error)
  }
  return res.changes
}

// Busca o handoff cuja filha é esta sessão (pra reconciliar no PTY exit). NULL se
// a sessão não veio de um handoff.
export function getByChildSession(childSessionId: string): Handoff | null {
  const row = getDb()
    .prepare(`${SELECT_HANDOFF} WHERE h.child_session_id = ?`)
    .get(childSessionId) as HandoffRow | undefined
  return row ? toEntity(row) : null
}

// A mãe consumiu o resultado: proxy = leu via handoff_result com status='done'.
// Idempotente: o WHERE consumed_at IS NULL garante uma única marcação (e um único
// evento 'consume'), mesmo com polling repetido. Só conta pra handoffs done.
export function markConsumed(id: string): Handoff {
  const res = getDb()
    .prepare(
      "UPDATE handoffs SET consumed_at = ?, updated_at = ? WHERE id = ? AND consumed_at IS NULL AND status = 'done'",
    )
    .run(Date.now(), Date.now(), id)
  if (res.changes > 0) logEvent(id, 'consume', 'done', 'done')
  return fresh(id)
}

// Feedback humano sobre a utilidade do handoff: useful | wrong | partial. Persiste
// o outcome e loga um evento 'feedback' (to_status = status corrente, detail =
// outcome). Permite revisão (sobrescreve outcome anterior).
export function setOutcome(id: string, outcome: HandoffOutcome): Handoff {
  const status = currentStatus(id)
  if (status === null) throw new Error(`handoff not found: ${id}`)
  getDb()
    .prepare('UPDATE handoffs SET outcome = ?, updated_at = ? WHERE id = ?')
    .run(outcome, Date.now(), id)
  logEvent(id, 'feedback', status, status, outcome)
  return fresh(id)
}

// Dedup por alvo: handoff ativo (pending/approved/running/needs_input) pro mesmo
// repo-alvo. Usado pra evitar dois agentes mutando o mesmo repo em paralelo.
export function findActiveByTarget(targetRepoId: string): Handoff | null {
  const row = getDb()
    .prepare(
      `${SELECT_HANDOFF} WHERE h.target_repo_id = ? AND h.status IN ('pending','approved','running','needs_input') ORDER BY h.created_at DESC LIMIT 1`,
    )
    .get(targetRepoId) as HandoffRow | undefined
  return row ? toEntity(row) : null
}
