import type Database from 'better-sqlite3'

export const version = 63
export const name = '063_sessions_hibernated_at'

// Conversa que saiu pelo /exit da hibernação e ainda não acordou. Era só um Set em
// memória: depois de um restart/reboot o wake não sabia que a sessão tinha
// hibernado e voltava sem as flags do spawn (spawn_args, 061).
export function up(db: Database.Database): void {
  db.exec('ALTER TABLE sessions ADD COLUMN hibernated_at INTEGER')
}
