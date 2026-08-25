import type Database from 'better-sqlite3'

export const version = 40
export const name = '040_service_proxy_calls'

// Auditoria do proxy de serviços (env hub): uma linha por chamada que o main
// fez em nome de uma sessão via MCP. session_id fica solto (sem FK): a chamada
// pode vir de sessão anônima (motherSessionId null) e a auditoria precisa
// sobreviver à limpeza de sessions. ATENÇÃO: session_id é DECLARADO pelo
// cliente MCP (?s= na conexão), não verificado — trate como rótulo de
// atribuição, nunca como identidade autenticada. `error` já chega REDIGIDO
// (o proxy passa tudo por createSecretRedactor antes de persistir).
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE service_proxy_calls (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      session_id TEXT,
      service TEXT NOT NULL,
      operation TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
      duration_ms INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX idx_service_proxy_calls_ts ON service_proxy_calls(ts DESC);
    CREATE INDEX idx_service_proxy_calls_service ON service_proxy_calls(service, ts DESC);
  `)
}
