import type Database from 'better-sqlite3'

export const version = 62
export const name = '062_prompt_queue_items'

// Fila de prompts durável: um item aceito como 'queued' sobrevive a kill -9 do
// main e é reentregue quando a conversa (cc_session_id) tiver PTY viva de novo.
// session_id é a PTY de quando foi aceito; a conversa troca de sessions.id ao
// retomar, por isso o alvo de verdade é o cc_session_id.
// state: queued → delivering (gravado antes do write no PTY) → linha removida.
// 'uncertain' = boot achou um delivering sem prova no transcript: espera o usuário.
// (060 e 061 ficam com composer_drafts e sessions_spawn_args, em outras branches.)
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE prompt_queue_items (
      id               TEXT PRIMARY KEY,
      session_id       TEXT NOT NULL,
      cc_session_id    TEXT,
      text             TEXT NOT NULL,
      from_session_id  TEXT,
      bypass_attention INTEGER NOT NULL DEFAULT 0,
      state            TEXT NOT NULL CHECK (state IN ('queued','delivering','uncertain')),
      created_at       INTEGER NOT NULL,
      delivering_at    INTEGER
    );
    CREATE INDEX idx_prompt_queue_items_cc ON prompt_queue_items(cc_session_id);
  `)
}
