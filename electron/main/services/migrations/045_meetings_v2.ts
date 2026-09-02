import type Database from 'better-sqlite3'

export const version = 45
export const name = '045_meetings_v2'

// Reuniões v2 (notetaker). Nomes *_v2 evitam colisão com bancos antigos que
// passaram pelas 022-044 (a feature anterior foi derrubada na 044).
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE meetings_v2 (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('recording','processing','done','error')),
      started_at INTEGER NOT NULL, ended_at INTEGER,
      raw_notes TEXT NOT NULL DEFAULT '', summary_md TEXT, them_label TEXT NOT NULL DEFAULT 'Participante',
      error TEXT, stt_model TEXT, summary_model TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE meeting_v2_segments (
      id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings_v2(id) ON DELETE CASCADE,
      speaker TEXT NOT NULL CHECK (speaker IN ('me','them')), text TEXT NOT NULL,
      start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, chunk_index INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX idx_meeting_v2_segments_meeting ON meeting_v2_segments(meeting_id, start_ms);
    CREATE TABLE meeting_v2_action_items (
      id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings_v2(id) ON DELETE CASCADE,
      title TEXT NOT NULL, quote TEXT, grounded INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('proposed','created','dismissed')), task_id TEXT, created_at INTEGER NOT NULL);
  `)
}
