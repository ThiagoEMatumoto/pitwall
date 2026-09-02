import type Database from 'better-sqlite3'

export const version = 47
export const name = '047_meetings_speakers'

// Reuniões v2 — diarização por nome + tarefas propostas com dono + telemetria
// de captura. Vozes conhecidas (meeting_v2_voices) sobrevivem à reunião; um
// speaker é a instância de uma voz numa reunião (voice_id NULL = ainda anônimo).
// `meeting_v2_segments.speaker` ('me'|'them') permanece: identidade vem de
// speaker_id; speaker_label é desnormalizado pra render sem join.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE meeting_v2_voices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      embedding BLOB NOT NULL,
      dim INTEGER NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE meeting_v2_speakers (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL REFERENCES meetings_v2(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      voice_id TEXT REFERENCES meeting_v2_voices(id) ON DELETE SET NULL,
      centroid BLOB,
      turn_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (meeting_id, label)
    );
    CREATE INDEX idx_meeting_v2_speakers_meeting ON meeting_v2_speakers(meeting_id);
  `)
  // SQLite aceita um ADD COLUMN por ALTER.
  db.exec('ALTER TABLE meeting_v2_segments ADD COLUMN speaker_id TEXT')
  db.exec('ALTER TABLE meeting_v2_segments ADD COLUMN speaker_label TEXT')
  db.exec('ALTER TABLE meeting_v2_action_items ADD COLUMN owner TEXT')
  db.exec(
    `ALTER TABLE meeting_v2_action_items ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'unknown'
       CHECK (owner_kind IN ('me','named','unknown'))`,
  )
  db.exec('ALTER TABLE meetings_v2 ADD COLUMN last_error TEXT')
  db.exec('ALTER TABLE meetings_v2 ADD COLUMN respawns INTEGER NOT NULL DEFAULT 0')
  db.exec('ALTER TABLE meetings_v2 ADD COLUMN mic_level_dbfs REAL')
  db.exec(
    `ALTER TABLE meetings_v2 ADD COLUMN diarization TEXT
       CHECK (diarization IS NULL OR diarization IN ('on','off','unavailable'))`,
  )
}
