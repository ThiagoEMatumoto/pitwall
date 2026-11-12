import type Database from 'better-sqlite3'

export const version = 69
export const name = '069_drop_agent_messages'

// O canal agente↔agente (agent_ask) saiu do app; esta migration só recolhe a
// tabela órfã. Como na 064: a 052 continua no array, porque um banco antigo
// aplica a cadeia inteira em ordem. Ninguém referencia agent_messages por FK e
// os dois índices caem com ela.
export function up(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS agent_messages')
}
