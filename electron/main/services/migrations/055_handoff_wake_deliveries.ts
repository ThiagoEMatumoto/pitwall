import type Database from 'better-sqlite3'

export const version = 55
export const name = '055_handoff_wake_deliveries'

// Ledger do acordador da F1: uma linha por EVENTO de handoff que tentou acordar a
// mãe. Eventos coalescidos no mesmo envelope dividem o wake_id (= id do item da
// PromptQueue; uuid próprio quando nem chegou a enfileirar). outcome é o contador
// consumível — feature_health/overview leem daqui o que não chegou. Machine-local
// e FORA do sync: fala de sessions.id desta máquina, como agent_messages (052).
// Sem FK para handoffs: o ledger sobrevive à limpeza de handoffs.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE handoff_wake_deliveries (
      id                TEXT PRIMARY KEY,
      wake_id           TEXT NOT NULL,
      handoff_id        TEXT NOT NULL,
      mother_session_id TEXT,
      reason            TEXT NOT NULL,
      outcome           TEXT NOT NULL,
      detail            TEXT,
      created_at        INTEGER NOT NULL,
      held_at           INTEGER,
      delivered_at      INTEGER,
      finished_at       INTEGER,
      fetched_at        INTEGER
    );
    CREATE INDEX idx_wake_deliveries_handoff ON handoff_wake_deliveries(handoff_id, created_at);
    CREATE INDEX idx_wake_deliveries_wake ON handoff_wake_deliveries(wake_id);
    CREATE INDEX idx_wake_deliveries_mother ON handoff_wake_deliveries(mother_session_id, fetched_at);
    CREATE INDEX idx_wake_deliveries_outcome ON handoff_wake_deliveries(outcome, created_at);
  `)
}
