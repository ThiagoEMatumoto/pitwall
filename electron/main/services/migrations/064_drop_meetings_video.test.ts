import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'
import { up as up064 } from './064_drop_meetings_video'

const DROPPED = [
  'video_renders',
  'video_character_refs',
  'video_assets',
  'video_script_lines',
  'video_scenes',
  'video_project_cast',
  'video_projects',
  'video_templates',
  'video_characters',
  'video_brand_kits',
  'meeting_v2_speakers',
  'meeting_v2_voices',
  'meeting_v2_action_items',
  'meeting_v2_segments',
  'meetings_v2',
]

function applyUpTo063(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 64)) {
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

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  )
}

// Cobre o ciclo video_brand_kits.logo_asset_id → video_assets → video_projects →
// video_brand_kits: com foreign_keys ON, o DROP de uma mãe ainda referenciada falha.
function seedVideo(db: Database.Database): void {
  const now = 1
  db.prepare(
    `INSERT INTO video_brand_kits (id, name, tokens, tone_of_voice, tts_voices, created_at, updated_at)
     VALUES ('bk1', 'Pitwall', '{}', 'seco', '{}', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO video_characters (id, name, canonical_description, visual_spec, voice_id, created_at, updated_at)
     VALUES ('c1', 'Nina', 'engenheira', '{}', 'v1', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO video_templates (id, kind, name, scene_blueprint, brand_kit_id, default_cast, created_at, updated_at)
     VALUES ('t1', 'promo', 'Promo', '[]', 'bk1', '["c1"]', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO video_projects (id, slug, title, kind, template_id, brand_kit_id, locales, theme_preset, created_at, updated_at)
     VALUES ('p1', 'promo', 'Promo', 'promo', 't1', 'bk1', '["pt-BR"]', 'slate', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO video_project_cast (project_id, character_id, role_in_piece) VALUES ('p1', 'c1', 'x')`,
  ).run()
  db.prepare(
    `INSERT INTO video_scenes (id, project_id, scene_id, ord, role, target_sec, visual, created_at, updated_at)
     VALUES ('s1', 'p1', 'open', 0, 'tensão', 7, 'Escuro.', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO video_script_lines (id, project_id, scene_id, locale, kind, text, text_hash, ord)
     VALUES ('l1', 'p1', 'open', 'pt-BR', 'narration', 'Oi.', 'h', 0)`,
  ).run()
  db.prepare(
    `INSERT INTO video_assets (id, project_id, scene_id, kind, locale, path, hash, provider, model, created_at)
     VALUES ('a1', 'p1', 'open', 'audio', 'pt-BR', 'a.mp3', 'h', 'elevenlabs', 'm', ?)`,
  ).run(now)
  db.prepare(
    `INSERT INTO video_assets (id, project_id, scene_id, kind, path, hash, provider, model, created_at)
     VALUES ('a2', NULL, NULL, 'character', 'nina.png', 'h2', 'gemini', 'imagen', ?)`,
  ).run(now)
  db.prepare(`UPDATE video_brand_kits SET logo_asset_id = 'a2' WHERE id = 'bk1'`).run()
  db.prepare(
    `INSERT INTO video_character_refs (id, character_id, asset_id, is_approved, ord)
     VALUES ('r1', 'c1', 'a2', 1, 0)`,
  ).run()
  db.prepare(
    `INSERT INTO video_renders (id, project_id, locale, status, created_at) VALUES ('rd1', 'p1', 'pt-BR', 'queued', ?)`,
  ).run(now)
}

function seedMeetings(db: Database.Database): void {
  db.prepare(
    `INSERT INTO meetings_v2 (id, title, status, started_at, created_at, updated_at)
     VALUES ('m1', 'R', 'done', 1, 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO meeting_v2_segments (id, meeting_id, speaker, text, start_ms, end_ms, chunk_index, created_at)
     VALUES ('sg1', 'm1', 'me', 'oi', 0, 1, 0, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO meeting_v2_action_items (id, meeting_id, title, grounded, status, created_at)
     VALUES ('ai1', 'm1', 'Fazer', 0, 'proposed', 1)`,
  ).run()
  db.prepare(
    `INSERT INTO meeting_v2_voices (id, name, embedding, dim, created_at, updated_at)
     VALUES ('v1', 'Ana', X'00', 1, 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO meeting_v2_speakers (id, meeting_id, label, voice_id) VALUES ('sp1', 'm1', 'Ana', 'v1')`,
  ).run()
}

function seedDiagramLinks(db: Database.Database): void {
  db.prepare(
    `INSERT INTO diagrams (id, title, kind, status, source_format, scene, created_at, updated_at)
     VALUES ('d1', 'D', 'flow', 'active', 'scene', '{}', 1, 1)`,
  ).run()
  const link = db.prepare(
    `INSERT INTO diagram_links (diagram_id, parent_type, parent_id) VALUES ('d1', ?, ?)`,
  )
  link.run('meeting', 'm1')
  link.run('feature', 'f1')
}

describe('064_drop_meetings_video', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyUpTo063(db)
  })

  afterEach(() => db.close())

  it('derruba as 15 tabelas de Reuniões e Video Lab mesmo com linhas e FKs ativas', () => {
    seedVideo(db)
    seedMeetings(db)

    db.transaction(() => up064(db))()

    for (const table of DROPPED) expect(tableExists(db, table), table).toBe(false)
    const leftovers = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE name LIKE 'video\\_%' ESCAPE '\\' OR name LIKE 'meeting%'`,
      )
      .all()
    expect(leftovers).toEqual([])
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('apaga só os diagram_links de reunião e preserva o resto', () => {
    seedMeetings(db)
    seedDiagramLinks(db)

    up064(db)

    expect(
      db.prepare('SELECT parent_type, parent_id FROM diagram_links ORDER BY parent_type').all(),
    ).toEqual([{ parent_type: 'feature', parent_id: 'f1' }])
    expect(db.prepare('SELECT COUNT(*) AS n FROM diagrams').get()).toEqual({ n: 1 })
  })

  it('é idempotente num banco onde as tabelas já não existem', () => {
    up064(db)
    expect(() => up064(db)).not.toThrow()
  })

  it('está registrada no array depois da 063', () => {
    const versions = migrations.map((m) => m.version)
    expect(versions).toContain(63)
    expect(versions).toContain(64)
  })
})
