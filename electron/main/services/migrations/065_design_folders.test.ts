import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'
import { up as up065 } from './065_design_folders'

function applyUpTo064(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 65)) {
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

function insertDoc(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO design_documents (id, title, status, tokens, fonts, global_css, created_at, updated_at)
     VALUES (?, 'Doc', 'active', '{}', '[]', '', 1, 1)`,
  ).run(id)
}

describe('065_design_folders', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyUpTo064(db)
  })

  afterEach(() => db.close())

  it('preserva docs existentes sem pasta e sem thumbnail_at', () => {
    insertDoc(db, 'd1')

    db.transaction(() => up065(db))()

    expect(db.prepare('SELECT id, folder_id, thumbnail_at FROM design_documents').all()).toEqual([
      { id: 'd1', folder_id: null, thumbnail_at: null },
    ])
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('apagar a pasta devolve os docs para folder_id NULL', () => {
    up065(db)
    db.prepare(
      `INSERT INTO design_folders (id, name, created_at, updated_at) VALUES ('f1', 'Hub', 1, 1)`,
    ).run()
    insertDoc(db, 'd1')
    db.prepare(`UPDATE design_documents SET folder_id = 'f1' WHERE id = 'd1'`).run()

    db.prepare(`DELETE FROM design_folders WHERE id = 'f1'`).run()

    expect(db.prepare('SELECT folder_id FROM design_documents').get()).toEqual({ folder_id: null })
  })

  it('recusa folder_id que não existe', () => {
    up065(db)
    insertDoc(db, 'd1')
    expect(() =>
      db.prepare(`UPDATE design_documents SET folder_id = 'nope' WHERE id = 'd1'`).run(),
    ).toThrow(/FOREIGN KEY/)
  })

  it('cria o índice em folder_id', () => {
    up065(db)
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get('idx_design_documents_folder')
    expect(idx).toBeDefined()
  })

  it('está registrada no array depois da 064', () => {
    const versions = migrations.map((m) => m.version)
    expect(versions).toContain(64)
    expect(versions.at(-1)).toBe(65)
  })
})
