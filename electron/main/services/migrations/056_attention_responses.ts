import type Database from 'better-sqlite3'

export const version = 56
export const name = '056_attention_responses'

// Cada resposta a um menu da TUI dada pela UI (popover de atenção, quick look da
// filha): quanto o agente esperou por você e o que você escolheu. waited_ms conta
// da aparição do menu no espelho headless até o clique. Machine-local e FORA do
// sync, como a 052: referencia sessions.id desta máquina e o comando é texto de tela.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE attention_responses (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      handoff_id      TEXT,
      menu_kind       TEXT NOT NULL,
      tool            TEXT,
      command_summary TEXT,
      choice          TEXT NOT NULL,
      waited_ms       INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX idx_attention_responses_created ON attention_responses(created_at);
  `)
}
