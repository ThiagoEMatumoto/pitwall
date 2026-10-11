import type Database from 'better-sqlite3'

export const version = 61
export const name = '061_sessions_spawn_args'

// Flags do spawn original (JSON): o `claude --resume` não guarda permission-mode,
// model/effort/advisor, disallowedTools, system prompt nem --settings. Sem elas, o
// wake de uma sessão hibernada (e qualquer resume) voltava no default. Cada resume
// copia o valor para a linha nova: a cadeia de linhas da conversa não o perde.
export function up(db: Database.Database): void {
  db.exec('ALTER TABLE sessions ADD COLUMN spawn_args TEXT')
}
