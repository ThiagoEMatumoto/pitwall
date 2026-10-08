import type Database from 'better-sqlite3'

export const version = 59
export const name = '059_handoff_request_answer_key'

// A resposta a um pedido também é idempotente: o mesmo answer_idempotency_key (ou
// a mesma resposta) num pedido já resolvido devolve o que está gravado em vez de
// erro. É o duplo clique na Room e o retry da mãe depois de um timeout do MCP.
export function up(db: Database.Database): void {
  db.exec('ALTER TABLE handoff_requests ADD COLUMN answer_idempotency_key TEXT')
}
