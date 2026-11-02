import type Database from 'better-sqlite3'

export const version = 68
export const name = '068_sessions_auto_title'

// Título de EXIBIÇÃO das sessões não-filhas (shared/session-title.ts). Coluna
// própria porque sessions.title vira alias no agent-bus e espelha o endereço
// (`-n`) das filhas: o auto-título não pode mexer em nenhum dos dois.
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE sessions ADD COLUMN auto_title TEXT;
    ALTER TABLE sessions ADD COLUMN auto_title_at INTEGER;
    ALTER TABLE sessions ADD COLUMN auto_title_source TEXT;
  `)
}
