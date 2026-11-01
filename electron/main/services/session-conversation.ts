import type { Database } from 'better-sqlite3'
// Cada resume abre uma linha nova em sessions com o mesmo cc_session_id, mas os
// links 'session' de diagramas e designs foram gravados pelo id da linha que
// existia na hora. Filtrar por sessão compara pela conversa, não pela linha.
export function sessionParentClause(sessionId: string): { sql: string; params: string[] } {
  return {
    sql: `(parent_id = ? OR parent_id IN (
      SELECT s2.id FROM sessions s1
      JOIN sessions s2 ON s2.cc_session_id = s1.cc_session_id
      WHERE s1.id = ? AND s1.cc_session_id IS NOT NULL))`,
    params: [sessionId, sessionId],
  }
}

// Id da linha mais recente da conversa de cada sessão (a que um resume abriu
// depois do link). Sem cc_session_id, ou sem linha, fica o id recebido.
// Ordem preservada, sem repetidos.
export function currentSessionIds(db: Database, sessionIds: readonly string[]): string[] {
  const latest = db.prepare(
    `SELECT s2.id FROM sessions s1
     JOIN sessions s2 ON s2.cc_session_id = s1.cc_session_id
     WHERE s1.id = ? AND s1.cc_session_id IS NOT NULL
     ORDER BY s2.started_at DESC LIMIT 1`,
  )
  const out: string[] = []
  for (const id of sessionIds) {
    const row = latest.get(id) as { id: string } | undefined
    const current = row?.id ?? id
    if (!out.includes(current)) out.push(current)
  }
  return out
}
