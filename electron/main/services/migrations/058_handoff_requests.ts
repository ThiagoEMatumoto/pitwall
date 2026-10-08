import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export const version = 58
export const name = '058_handoff_requests'

// A pergunta da filha deixa de ser texto livre empilhado em handoffs.pending_question
// e vira uma linha em handoff_requests, resolvida uma a uma por id. pending_question
// fica como ESPELHO derivado dos requests abertos (syncHandoffMirror), porque
// HandoffCard, CrewPeek, o corpo do wake e as tools ainda o leem.
//
// attention_dismissals guarda o "dispensar/adiar" da fila humana sem tocar em
// handoffs nem em handoff_requests: triagem de exibição não é resposta.
//
// Sem FK para handoffs (mesmo racional da 055: a trilha sobrevive à limpeza).
// As duas tabelas são machine-local e ficam fora do sync, como handoffs.
//
// Backfill: cada handoff em needs_input com pergunta vira UM request 'question' com
// o texto empilhado inteiro. Separar por "\n\n" seria classificar por substring,
// e uma pergunta com parágrafos viraria duas. pending_question fora de needs_input
// é resíduo de ciclo antigo e não vira request.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE handoff_requests (
      id               TEXT PRIMARY KEY,
      handoff_id       TEXT NOT NULL,
      asker_session_id TEXT,
      escalated_by     TEXT,
      kind             TEXT NOT NULL CHECK (kind IN ('decision','confirmation','human_action','question')),
      question         TEXT NOT NULL,
      options_json     TEXT NOT NULL DEFAULT '[]',
      recommendation   TEXT,
      cost_of_error    TEXT,
      risk             TEXT CHECK (risk IS NULL OR risk IN ('destructive_data','deploy_infra_spend')),
      resolver         TEXT NOT NULL CHECK (resolver IN ('mother','human_only')),
      addressee        TEXT NOT NULL CHECK (addressee IN ('mother','human')),
      status           TEXT NOT NULL CHECK (status IN ('open','answered','rejected','cancelled')),
      answer           TEXT,
      answer_note      TEXT,
      answered_by      TEXT,
      idempotency_key  TEXT,
      created_at       INTEGER NOT NULL,
      escalated_at     INTEGER,
      resolved_at      INTEGER
    );
    CREATE INDEX idx_handoff_requests_open ON handoff_requests(handoff_id, status, created_at);
    CREATE UNIQUE INDEX idx_handoff_requests_idem ON handoff_requests(handoff_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE TABLE attention_dismissals (
      dedup_key     TEXT PRIMARY KEY,
      request_id    TEXT,
      action        TEXT NOT NULL CHECK (action IN ('dismiss','snooze')),
      snoozed_until INTEGER,
      created_at    INTEGER NOT NULL
    );
  `)

  const rows = db
    .prepare(
      `SELECT id, child_session_id, pending_question, question_asked_at, updated_at
         FROM handoffs WHERE status = 'needs_input' AND pending_question IS NOT NULL`,
    )
    .all() as Array<{
    id: string
    child_session_id: string | null
    pending_question: string
    question_asked_at: number | null
    updated_at: number
  }>
  const insert = db.prepare(
    `INSERT INTO handoff_requests
       (id, handoff_id, asker_session_id, kind, question, resolver, addressee, status, created_at)
     VALUES (?, ?, ?, 'question', ?, 'mother', 'mother', 'open', ?)`,
  )
  const event = db.prepare(
    `INSERT INTO handoff_events (id, handoff_id, from_status, to_status, event, detail, at)
     VALUES (?, ?, 'needs_input', 'needs_input', 'migration_request_backfill', ?, ?)`,
  )
  const now = Date.now()
  for (const r of rows) {
    const requestId = randomUUID()
    insert.run(
      requestId,
      r.id,
      r.child_session_id,
      r.pending_question,
      r.question_asked_at ?? r.updated_at,
    )
    event.run(randomUUID(), r.id, requestId, now)
  }
}
