import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'
import { up as up066 } from './066_diagram_folders'

function applyUpTo065(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 66)) {
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

function insertDiagram(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO diagrams (id, title, created_at, updated_at) VALUES (?, 'Diagrama', 1, 1)`,
  ).run(id)
}

describe('066_diagram_folders', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyUpTo065(db)
  })

  afterEach(() => db.close())

  it('preserva diagramas existentes sem pasta', () => {
    insertDiagram(db, 'g1')

    db.transaction(() => up066(db))()

    expect(db.prepare('SELECT id, folder_id FROM diagrams').all()).toEqual([
      { id: 'g1', folder_id: null },
    ])
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('apagar a pasta devolve os diagramas para folder_id NULL', () => {
    up066(db)
    db.prepare(
      `INSERT INTO diagram_folders (id, name, created_at, updated_at) VALUES ('f1', 'Infra', 1, 1)`,
    ).run()
    insertDiagram(db, 'g1')
    db.prepare(`UPDATE diagrams SET folder_id = 'f1' WHERE id = 'g1'`).run()

    db.prepare(`DELETE FROM diagram_folders WHERE id = 'f1'`).run()

    expect(db.prepare('SELECT folder_id FROM diagrams').get()).toEqual({ folder_id: null })
  })

  it('recusa folder_id que não existe e nome vazio', () => {
    up066(db)
    insertDiagram(db, 'g1')
    expect(() =>
      db.prepare(`UPDATE diagrams SET folder_id = 'nope' WHERE id = 'g1'`).run(),
    ).toThrow(/FOREIGN KEY/)
    expect(() =>
      db
        .prepare(
          `INSERT INTO diagram_folders (id, name, created_at, updated_at) VALUES ('f2', '  ', 1, 1)`,
        )
        .run(),
    ).toThrow(/CHECK/)
  })

  it('cria o índice em folder_id', () => {
    up066(db)
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get('idx_diagrams_folder')
    expect(idx).toBeDefined()
  })

  it('está registrada no array depois da 065', () => {
    const versions = migrations.map((m) => m.version)
    expect(versions).toContain(65)
    expect(versions.at(-1)).toBe(66)
  })
})
