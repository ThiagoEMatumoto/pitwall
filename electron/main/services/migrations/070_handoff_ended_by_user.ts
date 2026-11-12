import type Database from 'better-sqlite3'

export const version = 70
export const name = '070_handoff_ended_by_user'

// O usuário encerrou a filha de propósito (X da aba / Encerrar). Coluna no
// handoff, e não tabela por conversa: handoffs.id não muda no resume (só o
// child_session_id é reapontado), então a marca acompanha a filha sem JOIN. Não
// é desfecho nem desvínculo: status e child_session_id seguem como estão.
export function up(db: Database.Database): void {
  db.exec('ALTER TABLE handoffs ADD COLUMN ended_by_user_at INTEGER')
}
