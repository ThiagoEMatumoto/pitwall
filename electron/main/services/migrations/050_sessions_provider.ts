import type Database from 'better-sqlite3'

export const version = 50
export const name = '050_sessions_provider'

// Seam multi-provider: qual CLI de agente roda a sessão. Toda linha existente é
// claude. launch_json guardará a configuração de launch para re-spawn (hoje null).
// `sessions` é machine-local e fica fora do sync (sync/bundle-format.ts).
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
    ALTER TABLE sessions ADD COLUMN launch_json TEXT;
  `)
}
