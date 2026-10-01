import type Database from 'better-sqlite3'

export const version = 52
export const name = '052_agent_messages'

// Agente perguntando a agente (P7). Cada ask é uma linha: quem perguntou, pra
// qual sessão (ou repo, quando o roteamento foi por repo), a profundidade da
// cadeia, a pergunta, a resposta e o ciclo pending → answered | expired.
// delivered_at = quando o envelope saiu pela PTY (antes disso está na fila
// on-idle). Machine-local e FORA do sync (ver sync/bundle-format.ts): fala de
// sessões DESTA máquina, e o Q&A cru não vai pro feature ledger.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE agent_messages (
      id              TEXT PRIMARY KEY,
      from_session_id TEXT NOT NULL,
      to_session_id   TEXT,
      to_repo_id      TEXT,
      feature_id      TEXT,
      depth           INTEGER NOT NULL,
      text            TEXT NOT NULL,
      reply           TEXT,
      status          TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      delivered_at    INTEGER,
      answered_at     INTEGER,
      expires_at      INTEGER NOT NULL
    );
    CREATE INDEX idx_agent_messages_pair ON agent_messages(from_session_id, to_session_id, created_at);
    CREATE INDEX idx_agent_messages_to ON agent_messages(to_session_id, status);
  `)
}
