// Estado "hibernada" no app.db (sessions.hibernated_at, migration 063): é o que diz
// ao wake que a conversa saiu pelo /exit da hibernação e deve voltar com as flags
// do spawn. Sobrevive a restart, reboot e queda de energia (writeDurably).
import type Database from 'better-sqlite3'
import { writeDurably } from '../durable-write'

// Gravado antes do /exit sair: depois dele o processo pode morrer junto com o app.
export function markHibernated(db: Database.Database, sessionId: string, at = Date.now()): void {
  writeDurably(db, () => {
    db.prepare('UPDATE sessions SET hibernated_at = ? WHERE id = ?').run(at, sessionId)
  })
}

// O /exit não virou hibernação (timeout, aba fechada, guarda segurou).
export function unmarkHibernated(db: Database.Database, sessionId: string): void {
  db.prepare('UPDATE sessions SET hibernated_at = NULL WHERE id = ?').run(sessionId)
}

export function isConversationHibernated(db: Database.Database, ccSessionId: string): boolean {
  return (
    db
      .prepare(
        'SELECT 1 FROM sessions WHERE cc_session_id = ? AND hibernated_at IS NOT NULL LIMIT 1',
      )
      .get(ccSessionId) !== undefined
  )
}

// A conversa voltou a ter PTY: a próxima hibernação marca a linha nova.
export function clearConversationHibernated(db: Database.Database, ccSessionId: string): void {
  db.prepare(
    'UPDATE sessions SET hibernated_at = NULL WHERE cc_session_id = ? AND hibernated_at IS NOT NULL',
  ).run(ccSessionId)
}
