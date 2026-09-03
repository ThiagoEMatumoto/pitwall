import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'
import { up as up048 } from './048_design_artboard_sizing'

function applyUpTo047(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 48)) {
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

function column(db: Database.Database, table: string, name: string): ColumnInfo | undefined {
  const rows = db.pragma(`table_info(${table})`) as ColumnInfo[]
  return rows.find((r) => r.name === name)
}

function seedArtboard(db: Database.Database): void {
  db.prepare(
    `INSERT INTO design_documents (id, title, status, tokens, fonts, global_css, created_at, updated_at)
     VALUES ('d1', 'Doc', 'active', '{}', '[]', '', 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO design_pages (id, document_id, name, position, viewport, created_at, updated_at)
     VALUES ('p1', 'd1', 'Page 1', 0, '{}', 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO design_artboards (id, page_id, name, x, y, width, height, tree, created_at, updated_at)
     VALUES ('a1', 'p1', 'Home', 0, 0, 1440, 900, '{}', 1, 1)`,
  ).run()
}

describe('migration 048_design_artboard_sizing', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyUpTo047(db)
  })

  afterEach(() => {
    db.close()
  })

  it('is registered as version 48 at the end of the chain', () => {
    const last = migrations[migrations.length - 1]
    expect(last.version).toBe(48)
    expect(last.name).toBe('048_design_artboard_sizing')
  })

  it('adds sizing NOT NULL DEFAULT fixed; existing rows get the default', () => {
    seedArtboard(db)
    up048(db)
    expect(column(db, 'design_artboards', 'sizing')).toMatchObject({
      type: 'TEXT',
      notnull: 1,
      dflt_value: "'fixed'",
    })
    expect(db.prepare(`SELECT sizing FROM design_artboards WHERE id = 'a1'`).get()).toEqual({
      sizing: 'fixed',
    })
  })

  it('CHECK accepts fixed/flow and refuses anything else', () => {
    seedArtboard(db)
    up048(db)
    db.prepare(`UPDATE design_artboards SET sizing = 'flow' WHERE id = 'a1'`).run()
    expect(() =>
      db.prepare(`UPDATE design_artboards SET sizing = 'fluid' WHERE id = 'a1'`).run(),
    ).toThrow(/CHECK/)
  })
})
