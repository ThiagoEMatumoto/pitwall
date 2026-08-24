import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'
import { up as up039 } from './039_diagram_library'

// Aplica 001-038 (igual ao runner real, respeitando disableForeignKeys) p/
// deixar o schema pronto ANTES da 039.
function applyUpTo038(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 39)) {
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

const NOW = 1_700_000_000_000

function insertItem(
  db: Database.Database,
  id = 'lib-1',
  opts: { status?: string; position?: number } = {},
): void {
  db.prepare(
    `INSERT INTO diagram_library_items (id, name, status, elements, created, position, updated_at)
     VALUES (?, 'Setas', ?, '[]', ?, ?, ?)`,
  ).run(id, opts.status ?? 'unpublished', NOW, opts.position ?? 0, NOW)
}

describe('migration 039_diagram_library', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyUpTo038(db)
    up039(db)
  })

  afterEach(() => {
    db.close()
  })

  it('cria diagram_library_items com as colunas esperadas', () => {
    const cols = (
      db.prepare(`PRAGMA table_info(diagram_library_items)`).all() as Array<{
        name: string
      }>
    ).map((c) => c.name)
    expect(cols).toEqual(['id', 'name', 'status', 'elements', 'created', 'position', 'updated_at'])
  })

  it('aplica default status unpublished e aceita name NULL', () => {
    db.prepare(
      `INSERT INTO diagram_library_items (id, elements, created, position, updated_at)
       VALUES ('sem-nome', '[]', ?, 0, ?)`,
    ).run(NOW, NOW)
    const row = db
      .prepare(`SELECT name, status FROM diagram_library_items WHERE id = 'sem-nome'`)
      .get() as { name: string | null; status: string }
    expect(row.name).toBeNull()
    expect(row.status).toBe('unpublished')
  })

  it('CHECK rejeita status fora do enum', () => {
    expect(() => insertItem(db, 'x', { status: 'draft' })).toThrow()
    insertItem(db, 'ok', { status: 'published' })
    const count = db.prepare('SELECT COUNT(*) AS n FROM diagram_library_items').get() as {
      n: number
    }
    expect(count.n).toBe(1)
  })

  it('PK rejeita id duplicado (merge por id mora no store, não no schema)', () => {
    insertItem(db, 'dup')
    expect(() => insertItem(db, 'dup', { position: 1 })).toThrow()
  })

  it('NOT NULL exige elements, created, position e updated_at', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO diagram_library_items (id, created, position, updated_at) VALUES ('e', 1, 0, 1)`,
        )
        .run(),
    ).toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO diagram_library_items (id, elements, created, updated_at) VALUES ('p', '[]', 1, 1)`,
        )
        .run(),
    ).toThrow()
  })
})
