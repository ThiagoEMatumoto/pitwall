import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'
import { up as up047 } from './047_meetings_speakers'

function applyUpTo046(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 47)) {
    if (m.disableForeignKeys) {
      db.pragma('foreign_keys = OFF')
      try {
        m.up(db)
      } finally {
        db.pragma('foreign_keys = ON')
      }
    } else {
      m.up(db)
    }
  }
}

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
}

function columns(db: Database.Database, table: string): Map<string, ColumnInfo> {
  const rows = db.pragma(`table_info(${table})`) as ColumnInfo[]
  return new Map(rows.map((r) => [r.name, r]))
}

describe('migration 047_meetings_speakers', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyUpTo046(db)
  })

  afterEach(() => {
    db.close()
  })

  it('está registrada como versão 47 na cadeia', () => {
    const entry = migrations.find((m) => m.version === 47)
    expect(entry?.name).toBe('047_meetings_speakers')
  })

  it('cria meeting_v2_voices e meeting_v2_speakers com as colunas do contrato', () => {
    up047(db)
    const voices = columns(db, 'meeting_v2_voices')
    expect([...voices.keys()]).toEqual(['id', 'name', 'embedding', 'dim', 'sample_count', 'created_at', 'updated_at'])
    expect(voices.get('sample_count')).toMatchObject({ notnull: 1, dflt_value: '1' })

    const speakers = columns(db, 'meeting_v2_speakers')
    expect([...speakers.keys()]).toEqual(['id', 'meeting_id', 'label', 'voice_id', 'centroid', 'turn_count'])
    expect(speakers.get('turn_count')).toMatchObject({ notnull: 1, dflt_value: '0' })
  })

  it('adiciona as colunas novas em segments, action_items e meetings', () => {
    up047(db)
    const segments = columns(db, 'meeting_v2_segments')
    expect(segments.has('speaker_id')).toBe(true)
    expect(segments.has('speaker_label')).toBe(true)
    expect(segments.has('speaker')).toBe(true)

    const items = columns(db, 'meeting_v2_action_items')
    expect(items.has('owner')).toBe(true)
    expect(items.get('owner_kind')).toMatchObject({ notnull: 1, dflt_value: "'unknown'" })

    const meetings = columns(db, 'meetings_v2')
    expect(meetings.has('last_error')).toBe(true)
    expect(meetings.get('respawns')).toMatchObject({ notnull: 1, dflt_value: '0' })
    expect(meetings.get('mic_level_dbfs')?.type).toBe('REAL')
    expect(meetings.has('diarization')).toBe(true)
  })

  it('rows existentes ganham os defaults e os CHECKs valem para valores novos', () => {
    db.prepare(
      `INSERT INTO meetings_v2 (id, title, status, started_at, created_at, updated_at)
       VALUES ('m1', 'Antiga', 'done', 1, 1, 1)`,
    ).run()
    db.prepare(
      `INSERT INTO meeting_v2_action_items (id, meeting_id, title, grounded, status, created_at)
       VALUES ('a1', 'm1', 'Fazer', 0, 'proposed', 1)`,
    ).run()
    up047(db)

    expect(db.prepare(`SELECT owner, owner_kind FROM meeting_v2_action_items WHERE id = 'a1'`).get()).toEqual({
      owner: null,
      owner_kind: 'unknown',
    })
    expect(db.prepare(`SELECT respawns, diarization FROM meetings_v2 WHERE id = 'm1'`).get()).toEqual({
      respawns: 0,
      diarization: null,
    })
    expect(() =>
      db.prepare(`UPDATE meeting_v2_action_items SET owner_kind = 'robot' WHERE id = 'a1'`).run(),
    ).toThrow(/CHECK/)
    expect(() => db.prepare(`UPDATE meetings_v2 SET diarization = 'maybe' WHERE id = 'm1'`).run()).toThrow(/CHECK/)
    db.prepare(`UPDATE meetings_v2 SET diarization = 'on' WHERE id = 'm1'`).run()
  })

  it('speakers cascateiam com a reunião; voice apagada zera voice_id (SET NULL)', () => {
    up047(db)
    db.prepare(
      `INSERT INTO meetings_v2 (id, title, status, started_at, created_at, updated_at)
       VALUES ('m1', 'R', 'done', 1, 1, 1)`,
    ).run()
    db.prepare(
      `INSERT INTO meeting_v2_voices (id, name, embedding, dim, created_at, updated_at)
       VALUES ('v1', 'Ana', X'00', 1, 1, 1)`,
    ).run()
    db.prepare(`INSERT INTO meeting_v2_speakers (id, meeting_id, label, voice_id) VALUES ('s1', 'm1', 'Ana', 'v1')`).run()

    expect(() =>
      db.prepare(`INSERT INTO meeting_v2_speakers (id, meeting_id, label) VALUES ('s2', 'm1', 'Ana')`).run(),
    ).toThrow(/UNIQUE/)

    db.prepare(`DELETE FROM meeting_v2_voices WHERE id = 'v1'`).run()
    expect(db.prepare(`SELECT voice_id FROM meeting_v2_speakers WHERE id = 's1'`).get()).toEqual({ voice_id: null })

    db.prepare(`DELETE FROM meetings_v2 WHERE id = 'm1'`).run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_v2_speakers').get()).toEqual({ n: 0 })
  })
})
