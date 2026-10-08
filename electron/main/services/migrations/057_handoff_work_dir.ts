import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { resolveHandoffWorkDir } from '../work-dir'

export const version = 57
export const name = '057_handoff_work_dir'

// A posse deixa de ser por repo e passa a ser por DIRETÓRIO DE TRABALHO: várias
// filhas no mesmo repo é o uso normal (uma por worktree, ou uma revisora em plan
// lendo o checkout da implementer). O que não pode é duas filhas que ESCREVEM no
// mesmo diretório, então:
//   - handoffs.work_dir guarda o cwd efetivo da filha (worktree da feature nesse
//     repo, senão a raiz do repo), decidido no create;
//   - o índice UNIQUE da 054 (por target_repo_id) sai, e entra um por work_dir
//     que ignora filhas em mode 'plan' (read-only não disputa o checkout).
//
// Backfill: as linhas ativas recebem o work_dir pela MESMA função do create (que
// olha o disco pra decidir se o worktree ainda existe); as encerradas também,
// pra a coluna valer como histórico. Sob a 054 já havia no máximo um ativo por
// repo, mas dois repos podem apontar pro mesmo path — essas duplicatas são
// saneadas como na 054 antes de criar o índice, senão o boot quebraria.
const ACTIVE_WRITER =
  "status IN ('pending','approved','running','needs_input') AND dismissed_at IS NULL AND mode <> 'plan'"
const ERROR =
  'Duplicata ativa saneada pela migration 057 (mantido o handoff mais recente do diretório)'

export function up(db: Database.Database): void {
  db.exec('ALTER TABLE handoffs ADD COLUMN work_dir TEXT')

  const rows = db.prepare('SELECT id, target_repo_id, feature_id FROM handoffs').all() as Array<{
    id: string
    target_repo_id: string
    feature_id: string | null
  }>
  const setDir = db.prepare('UPDATE handoffs SET work_dir = ? WHERE id = ?')
  for (const r of rows) setDir.run(resolveHandoffWorkDir(r.target_repo_id, r.feature_id, db), r.id)

  const stale = db
    .prepare(
      `SELECT h.id, h.status FROM handoffs h
        WHERE h.work_dir IS NOT NULL
          AND h.status IN ('pending','approved','running','needs_input')
          AND h.dismissed_at IS NULL AND h.mode <> 'plan'
          AND EXISTS (
            SELECT 1 FROM handoffs n
             WHERE n.work_dir = h.work_dir
               AND n.status IN ('pending','approved','running','needs_input')
               AND n.dismissed_at IS NULL AND n.mode <> 'plan'
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

  db.exec('DROP INDEX IF EXISTS idx_handoffs_active_target')
  db.exec(
    `CREATE UNIQUE INDEX idx_handoffs_active_work_dir ON handoffs(work_dir) WHERE ${ACTIVE_WRITER}`,
  )
}
