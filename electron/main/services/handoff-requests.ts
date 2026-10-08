import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import {
  resolverFor,
  type CreateRequestInput,
  type HandoffRequest,
  type RequestAddressee,
  type RequestKind,
  type RequestOption,
  type RequestResolver,
  type RequestRisk,
  type RequestStatus,
} from '../../../shared/types/handoff-request'
import type { HandoffRequestHealth } from '../../../shared/types/ipc'

// Store dos pedidos tipados (migration 058). Não importa handoff-store: grava a
// própria linha em handoff_events, pra não fechar ciclo de import (handoff-store
// chama cancelOpen/createRequest daqui).

interface RequestRow {
  id: string
  handoff_id: string
  asker_session_id: string | null
  escalated_by: string | null
  kind: string
  question: string
  options_json: string
  recommendation: string | null
  cost_of_error: string | null
  risk: string | null
  resolver: string
  addressee: string
  status: string
  answer: string | null
  answer_note: string | null
  answered_by: string | null
  idempotency_key: string | null
  created_at: number
  escalated_at: number | null
  resolved_at: number | null
}

function toEntity(r: RequestRow): HandoffRequest {
  return {
    id: r.id,
    handoffId: r.handoff_id,
    askerSessionId: r.asker_session_id,
    escalatedBy: r.escalated_by,
    kind: r.kind as RequestKind,
    question: r.question,
    options: JSON.parse(r.options_json) as RequestOption[],
    recommendation: r.recommendation,
    costOfError: r.cost_of_error,
    risk: r.risk as RequestRisk | null,
    resolver: r.resolver as RequestResolver,
    addressee: r.addressee as RequestAddressee,
    status: r.status as RequestStatus,
    answer: r.answer,
    answerNote: r.answer_note,
    answeredBy: r.answered_by as 'mother' | 'human' | null,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
    escalatedAt: r.escalated_at,
    resolvedAt: r.resolved_at,
  }
}

export class RequestResolveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestResolveError'
  }
}

export class HumanOnlyError extends Error {
  readonly code = 'HUMAN_ONLY' as const
  constructor(readonly request: HandoffRequest) {
    super(
      `Este pedido é human_only${request.risk ? ` (${request.risk})` : ''}: só o humano resolve. Use handoff_escalate se ainda não está na fila humana.`,
    )
    this.name = 'HumanOnlyError'
  }
}

function handoffStatus(handoffId: string): string | null {
  const row = getDb().prepare('SELECT status FROM handoffs WHERE id = ?').get(handoffId) as
    { status: string } | undefined
  return row?.status ?? null
}

function insertEvent(
  handoffId: string,
  event: string,
  fromStatus: string | null,
  toStatus: string,
  detail: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO handoff_events (id, handoff_id, from_status, to_status, event, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), handoffId, fromStatus, toStatus, event, detail, Date.now())
}

function recordRequestEvent(handoffId: string, event: string, detail: string): void {
  const s = handoffStatus(handoffId)
  if (s !== null) insertEvent(handoffId, event, s, s, detail)
}

export function get(id: string): HandoffRequest | null {
  const row = getDb().prepare('SELECT * FROM handoff_requests WHERE id = ?').get(id) as
    RequestRow | undefined
  return row ? toEntity(row) : null
}

// rowid desempata pedidos criados no mesmo milissegundo (ordem de chegada).
export function listOpen(opts: { handoffId?: string } = {}): HandoffRequest[] {
  const rows = (
    opts.handoffId
      ? getDb()
          .prepare(
            "SELECT * FROM handoff_requests WHERE status = 'open' AND handoff_id = ? ORDER BY created_at, rowid",
          )
          .all(opts.handoffId)
      : getDb()
          .prepare(
            "SELECT * FROM handoff_requests WHERE status = 'open' ORDER BY created_at, rowid",
          )
          .all()
  ) as RequestRow[]
  return rows.map(toEntity)
}

export function listFor(handoffId: string): HandoffRequest[] {
  const rows = getDb()
    .prepare('SELECT * FROM handoff_requests WHERE handoff_id = ? ORDER BY created_at, rowid')
    .all(handoffId) as RequestRow[]
  return rows.map(toEntity)
}

// A ÚNICA regra de needs_input: o handoff vivo espera enquanto houver pedido
// aberto. pending_question vira espelho das perguntas abertas (compat com os
// leitores antigos) e question_asked_at é o "bloqueada desde" do mais antigo.
// Nunca toca handoff terminal.
export function syncHandoffMirror(handoffId: string): void {
  const status = handoffStatus(handoffId)
  if (status !== 'running' && status !== 'needs_input') return
  const open = listOpen({ handoffId })
  const now = Date.now()
  if (open.length > 0) {
    getDb()
      .prepare(
        `UPDATE handoffs
           SET status = 'needs_input', pending_question = ?, question_asked_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(open.map((r) => r.question).join('\n\n'), open[0].createdAt, now, handoffId)
    return
  }
  if (status !== 'needs_input') return
  getDb()
    .prepare(
      `UPDATE handoffs
         SET status = 'running', pending_question = NULL, question_asked_at = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .run(now, handoffId)
  insertEvent(handoffId, 'resume', 'needs_input', 'running', null)
}

export function createRequest(
  handoffId: string,
  input: CreateRequestInput,
  askerSessionId: string | null,
): { request: HandoffRequest; created: boolean } {
  const db = getDb()
  return db.transaction(() => {
    if (input.idempotencyKey) {
      const existing = db
        .prepare('SELECT * FROM handoff_requests WHERE handoff_id = ? AND idempotency_key = ?')
        .get(handoffId, input.idempotencyKey) as RequestRow | undefined
      if (existing) return { request: toEntity(existing), created: false }
    }
    const id = randomUUID()
    const now = Date.now()
    const resolver = resolverFor(input.risk, input.resolver)
    const kind = input.kind ?? 'question'
    db.prepare(
      `INSERT INTO handoff_requests
         (id, handoff_id, asker_session_id, escalated_by, kind, question, options_json,
          recommendation, cost_of_error, risk, resolver, addressee, status, idempotency_key,
          created_at, escalated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    ).run(
      id,
      handoffId,
      askerSessionId,
      input.escalatedBy ?? null,
      kind,
      input.question,
      JSON.stringify(input.options ?? []),
      input.recommendation ?? null,
      input.costOfError ?? null,
      input.risk ?? null,
      resolver,
      resolver === 'human_only' ? 'human' : 'mother',
      input.idempotencyKey ?? null,
      now,
      input.escalatedBy ? now : null,
    )
    syncHandoffMirror(handoffId)
    recordRequestEvent(handoffId, 'request_open', `${id} ${kind}`)
    if (input.escalatedBy) recordRequestEvent(handoffId, 'request_escalate', id)
    return { request: get(id)!, created: true }
  })()
}

export interface AnswerInput {
  // key de uma option (validada); sem options, use text.
  choice?: string
  // Texto livre: vira a resposta quando não há choice, senão a nota.
  text?: string
  by: 'mother' | 'human'
  reject?: boolean
}

export function answerRequest(requestId: string, input: AnswerInput): HandoffRequest {
  const db = getDb()
  return db.transaction(() => {
    const r = get(requestId)
    if (!r) throw new RequestResolveError(`Pedido não encontrado: ${requestId}`)
    if (r.status !== 'open') {
      throw new RequestResolveError(`O pedido ${requestId} já está ${r.status}.`)
    }
    if (input.by === 'mother' && r.resolver === 'human_only') throw new HumanOnlyError(r)
    if (
      !input.reject &&
      input.choice !== undefined &&
      r.options.length > 0 &&
      !r.options.some((o) => o.key === input.choice)
    ) {
      throw new RequestResolveError(
        `Opção "${input.choice}" inválida para ${requestId}. Válidas: ${r.options.map((o) => o.key).join(', ')}.`,
      )
    }
    const text = input.text?.trim() ? input.text : null
    const answer = input.choice ?? text
    const note = input.choice !== undefined ? text : null
    const status = input.reject ? 'rejected' : 'answered'
    db.prepare(
      `UPDATE handoff_requests
         SET status = ?, answer = ?, answer_note = ?, answered_by = ?, resolved_at = ?
       WHERE id = ?`,
    ).run(status, answer, note, input.by, Date.now(), requestId)
    recordRequestEvent(
      r.handoffId,
      input.reject ? 'request_reject' : 'request_answer',
      `${requestId} by=${input.by}`,
    )
    syncHandoffMirror(r.handoffId)
    return get(requestId)!
  })()
}

// A mãe passa o pedido da filha para o humano. Idempotente se já é human_only.
export function escalateRequest(requestId: string, escalatedBy: string): HandoffRequest {
  const db = getDb()
  return db.transaction(() => {
    const r = get(requestId)
    if (!r) throw new RequestResolveError(`Pedido não encontrado: ${requestId}`)
    if (r.status !== 'open') {
      throw new RequestResolveError(`O pedido ${requestId} já está ${r.status}.`)
    }
    if (r.resolver === 'human_only' && r.escalatedBy) return r
    db.prepare(
      `UPDATE handoff_requests
         SET resolver = 'human_only', addressee = 'human', escalated_by = ?, escalated_at = ?
       WHERE id = ?`,
    ).run(escalatedBy, Date.now(), requestId)
    recordRequestEvent(r.handoffId, 'request_escalate', requestId)
    return get(requestId)!
  })()
}

// Saída de running/needs_input: pedido aberto num handoff encerrado não tem mais
// quem o resolva. Sem acordar ninguém e sem espelho (o handoff já é terminal).
export function cancelOpen(handoffId: string, reason: string): number {
  const open = listOpen({ handoffId })
  if (open.length === 0) return 0
  const now = Date.now()
  const update = getDb().prepare(
    "UPDATE handoff_requests SET status = 'cancelled', answer_note = ?, resolved_at = ? WHERE id = ? AND status = 'open'",
  )
  for (const r of open) {
    update.run(reason, now, r.id)
    recordRequestEvent(handoffId, 'request_cancel', `${r.id} ${reason}`)
  }
  return open.length
}

// Triagem da fila humana: só exibição. Não toca handoffs nem handoff_requests.
export function dismissAttention(dedupKey: string, requestId: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO attention_dismissals (dedup_key, request_id, action, snoozed_until, created_at)
       VALUES (?, ?, 'dismiss', NULL, ?)
       ON CONFLICT(dedup_key) DO UPDATE SET action = 'dismiss', snoozed_until = NULL,
         request_id = excluded.request_id, created_at = excluded.created_at`,
    )
    .run(dedupKey, requestId, Date.now())
}

export function snoozeAttention(dedupKey: string, requestId: string | null, until: number): void {
  getDb()
    .prepare(
      `INSERT INTO attention_dismissals (dedup_key, request_id, action, snoozed_until, created_at)
       VALUES (?, ?, 'snooze', ?, ?)
       ON CONFLICT(dedup_key) DO UPDATE SET action = 'snooze', snoozed_until = excluded.snoozed_until,
         request_id = excluded.request_id, created_at = excluded.created_at`,
    )
    .run(dedupKey, requestId, until, Date.now())
}

export interface ActiveDismissal {
  action: 'dismiss' | 'snooze'
  snoozedUntil: number | null
}

// Snooze vencido não volta no mapa: o item reaparece sozinho.
export function activeDismissals(now: number): Map<string, ActiveDismissal> {
  const rows = getDb()
    .prepare(
      `SELECT dedup_key, action, snoozed_until FROM attention_dismissals
        WHERE action = 'dismiss' OR snoozed_until > ?`,
    )
    .all(now) as Array<{ dedup_key: string; action: string; snoozed_until: number | null }>
  return new Map(
    rows.map((r) => [
      r.dedup_key,
      { action: r.action as 'dismiss' | 'snooze', snoozedUntil: r.snoozed_until },
    ]),
  )
}

export interface RequestProjection {
  ids: ReadonlySet<string>
  computedAt: number
}

// Gravado por attention-service a cada cálculo da fila (fica aqui pra loop-snapshot
// e overview não importarem o serviço de atenção e seus watchers de PTY).
let lastProjection: RequestProjection | null = null

export function recordProjection(p: RequestProjection): void {
  lastProjection = p
}

// human_only aberto que nenhuma projeção mostra e ninguém triou é pedido sumido:
// só o humano resolve, e ele não está vendo. Pedido mais novo que a última
// projeção ainda não teve chance de aparecer e não conta.
export function requestHealth(
  scope: { featureId?: string },
  projection: RequestProjection | null = lastProjection,
  now = Date.now(),
): HandoffRequestHealth {
  const rows = (
    scope.featureId
      ? getDb()
          .prepare(
            `SELECT r.id, r.created_at, r.escalated_at FROM handoff_requests r
               JOIN handoffs h ON h.id = r.handoff_id
              WHERE r.status = 'open' AND r.resolver = 'human_only' AND h.feature_id = ?`,
          )
          .all(scope.featureId)
      : getDb()
          .prepare(
            `SELECT id, created_at, escalated_at FROM handoff_requests
              WHERE status = 'open' AND resolver = 'human_only'`,
          )
          .all()
  ) as Array<{ id: string; created_at: number; escalated_at: number | null }>
  const triaged = activeDismissals(now)
  let visible = 0
  let triagedCount = 0
  const hidden: number[] = []
  for (const r of rows) {
    const since = r.escalated_at ?? r.created_at
    if (projection?.ids.has(r.id)) visible++
    else if (triaged.has(`request:${r.id}`)) triagedCount++
    else if (projection && since <= projection.computedAt) hidden.push(since)
  }
  return {
    openHumanOnly: rows.length,
    visibleHumanOnly: visible,
    triagedHumanOnly: triagedCount,
    hiddenHumanOnly: hidden.length,
    oldestHiddenAt: hidden.length > 0 ? Math.min(...hidden) : null,
    projectedAt: projection?.computedAt ?? null,
  }
}
