import type Database from 'better-sqlite3'

export const version = 68
export const name = '068_sessions_auto_title'

// Título de EXIBIÇÃO das sessões não-filhas (shared/session-title.ts). Coluna
// própria porque sessions.title espelha o endereço (`-n`) das filhas: o
// auto-título não pode mexer nele.
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE sessions ADD COLUMN auto_title TEXT;
    ALTER TABLE sessions ADD COLUMN auto_title_at INTEGER;
    ALTER TABLE sessions ADD COLUMN auto_title_source TEXT;
  `)
}
