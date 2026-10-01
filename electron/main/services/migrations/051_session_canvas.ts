import type Database from 'better-sqlite3'

export const version = 51
export const name = '051_session_canvas'

// Mapa de sessões (P8). canvas_positions guarda sessões/notas/grupos/lanes por
// escopo ('all' ou projects.id) — repos seguem em repos.canvas_x/y. Tudo aqui é
// machine-local e fica FORA do sync (ver sync/bundle-format.ts): as tabelas não
// entram em SYNCED_TABLES e `sessions` já é excluída.
//
// sessions.purpose é a edição do usuário (ou da própria sessão via MCP); a
// tarefa do handoff e o 1º prompt do transcript são derivados na leitura.
//
// canvas_positions.view_state: cartão de sessão recolhido/aberto/terminal. Linha
// só com view_state (cartão nunca arrastado) tem x/y NULL — o layout segue
// automático; quem lê posição filtra x NOT NULL (canvas-store.getCanvas).
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE canvas_positions (
      scope      TEXT NOT NULL,
      kind       TEXT NOT NULL,
      entity_id  TEXT NOT NULL,
      x          REAL,
      y          REAL,
      w          REAL,
      h          REAL,
      view_state TEXT,
      PRIMARY KEY (scope, kind, entity_id)
    );

    CREATE TABLE canvas_notes (
      id                  TEXT PRIMARY KEY,
      scope               TEXT NOT NULL,
      body_md             TEXT NOT NULL DEFAULT '',
      attached_session_id TEXT,
      color               TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE INDEX idx_canvas_notes_scope ON canvas_notes(scope);

    CREATE TABLE session_groups (
      id         TEXT PRIMARY KEY,
      scope      TEXT NOT NULL,
      name       TEXT NOT NULL,
      color      TEXT,
      created_at INTEGER NOT NULL
    );

    ALTER TABLE sessions ADD COLUMN purpose TEXT;
    ALTER TABLE sessions ADD COLUMN group_id TEXT;
    ALTER TABLE sessions ADD COLUMN last_summary TEXT;
    ALTER TABLE sessions ADD COLUMN last_summary_at INTEGER;
  `)
}
