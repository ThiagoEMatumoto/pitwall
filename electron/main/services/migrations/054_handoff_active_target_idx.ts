import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export const version = 54
export const name = '054_handoff_active_target_idx'

// Posse do repo-alvo vira garantia de banco: no máximo UM handoff ativo por
// target_repo_id. "Ativo" é o predicado do dedup (findActiveByTarget): status
// pending/approved/running/needs_input e não dispensado — dispensado sai do dock
// e não bloqueia, então também fica fora do índice.
//
// O índice falharia em bancos que já têm duplicatas (o dedup antigo rodava fora
// de transação e só no caminho MCP; force passava por cima). Antes de criá-lo, as
// duplicatas são saneadas: fica a mais recente de cada repo, as outras viram
// 'interrupted' (recuperável, não 'failed') com evento na trilha.
const ACTIVE = "status IN ('pending','approved','running','needs_input') AND dismissed_at IS NULL"
const ERROR = 'Duplicata ativa saneada pela migration 054 (mantido o handoff mais recente do repo)'

export function up(db: Database.Database): void {
  const stale = db
    .prepare(
      `SELECT h.id, h.status FROM handoffs h
        WHERE h.status IN ('pending','approved','running','needs_input')
          AND h.dismissed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM handoffs n
             WHERE n.target_repo_id = h.target_repo_id
               AND n.status IN ('pending','approved','running','needs_input')
               AND n.dismissed_at IS NULL
               AND (n.created_at > h.created_at OR (n.created_at = h.created_at AND n.id > h.id))
          )`,
    )
    .all() as Array<{ id: string; status: string }>

  const now = Date.now()
  const update = db.prepare(
    "UPDATE handoffs SET status = 'interrupted', error = ?, updated_at = ? WHERE id = ?",
  )
  const event = db.prepare(
    `INSERT INTO handoff_events (id, handoff_id, from_status, to_status, event, detail, at)
     VALUES (?, ?, ?, 'interrupted', 'migration_dedup', ?, ?)`,
  )
  for (const row of stale) {
    update.run(ERROR, now, row.id)
    event.run(randomUUID(), row.id, row.status, ERROR, now)
  }

  db.exec(
    `CREATE UNIQUE INDEX idx_handoffs_active_target ON handoffs(target_repo_id) WHERE ${ACTIVE}`,
  )
}
