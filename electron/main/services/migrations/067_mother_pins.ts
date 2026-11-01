import type Database from 'better-sqlite3'

export const version = 67
export const name = '067_mother_pins'

// "Essa é a mãe": papel marcado pelo humano, por CONVERSA. O resume cria um
// sessions.id novo a cada processo; chaveado pelo cc_session_id o pin sobrevive.
// Sessão sem cc (codex) usa o próprio sessions.id como chave.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE mother_pins (
      cc_session_id TEXT PRIMARY KEY,
      pinned_at INTEGER NOT NULL
    );
  `)
}
