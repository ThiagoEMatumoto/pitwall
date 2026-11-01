// Fonte única do "essa é a mãe". Chave = conversa (cc_session_id ?? sessions.id),
// a mesma do pinKey da Room: o pin sobrevive ao resume, que troca o sessions.id.
import type Database from 'better-sqlite3'
import { getDb } from './db'

export interface MotherPin {
  key: string
  pinnedAt: number
}

export function readMotherPinKeys(db: Database.Database): Set<string> {
  const rows = db.prepare('SELECT cc_session_id FROM mother_pins').all() as Array<{
    cc_session_id: string
  }>
  return new Set(rows.map((r) => r.cc_session_id))
}

export function listMotherPins(db: Database.Database = getDb()): MotherPin[] {
  const rows = db
    .prepare('SELECT cc_session_id, pinned_at FROM mother_pins ORDER BY pinned_at, rowid')
    .all() as Array<{ cc_session_id: string; pinned_at: number }>
  return rows.map((r) => ({ key: r.cc_session_id, pinnedAt: r.pinned_at }))
}

// Resolve a chave de conversa de uma linha de sessions. null = sessão inexistente.
export function motherPinKeyOf(sessionId: string, db: Database.Database = getDb()): string | null {
  const row = db.prepare('SELECT cc_session_id FROM sessions WHERE id = ?').get(sessionId) as
    | { cc_session_id: string | null }
    | undefined
  if (!row) return null
  return row.cc_session_id ?? sessionId
}

// Idempotente: marcar de novo preserva o pinned_at original (a ordem da Room).
export function setMotherPin(
  key: string,
  pinned: boolean,
  db: Database.Database = getDb(),
  now = Date.now(),
): boolean {
  const res = pinned
    ? db
        .prepare('INSERT INTO mother_pins (cc_session_id, pinned_at) VALUES (?, ?) ON CONFLICT DO NOTHING')
        .run(key, now)
    : db.prepare('DELETE FROM mother_pins WHERE cc_session_id = ?').run(key)
  return res.changes > 0
}

// A pane marcada como mãe que nunca teve conversa (nenhum transcript) volta do
// reinício como conversa nova: o pin passa para ela, mantendo o pinned_at (a ordem
// da Room). Conversa que existe não cede o pin: ela ainda é retomável.
export function inheritMotherPin(
  fromKey: string,
  toSessionId: string,
  deps: { hasTranscript: (ccSessionId: string) => boolean },
  db: Database.Database = getDb(),
): boolean {
  const toKey = motherPinKeyOf(toSessionId, db)
  if (!toKey || toKey === fromKey || deps.hasTranscript(fromKey)) return false
  const res = db
    .prepare(
      `UPDATE mother_pins SET cc_session_id = ?
        WHERE cc_session_id = ?
          AND NOT EXISTS (SELECT 1 FROM mother_pins WHERE cc_session_id = ?)`,
    )
    .run(toKey, fromKey, toKey)
  return res.changes > 0
}

// Import one-shot dos pins antigos (Room em localStorage, Dock): só acrescenta,
// na ordem recebida, sem desmarcar nada.
export function importMotherPins(
  keys: readonly string[],
  db: Database.Database = getDb(),
  now = Date.now(),
): number {
  const insert = db.prepare(
    'INSERT INTO mother_pins (cc_session_id, pinned_at) VALUES (?, ?) ON CONFLICT DO NOTHING',
  )
  let added = 0
  db.transaction(() => {
    keys.forEach((k, i) => {
      if (k.trim()) added += insert.run(k, now + i).changes
    })
  })()
  return added
}
