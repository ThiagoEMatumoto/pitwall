import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'
import { up as up038 } from './038_diagrams'

// Aplica 001-037 (igual ao runner real, respeitando disableForeignKeys) p/
// deixar o schema pronto ANTES da 038.
function applyUpTo037(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 38)) {
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

function insertDiagram(db: Database.Database, id = 'd1', title = 'Fluxo de handoff'): void {
  db.prepare(
    `INSERT INTO diagrams (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(id, title, NOW, NOW)
}

function insertVersion(db: Database.Database, diagramId = 'd1', version = 1): void {
  db.prepare(
    `INSERT INTO diagram_versions (id, diagram_id, version, author, summary, scene, created_at)
     VALUES (?, ?, ?, 'claude', 'versão inicial', '{"elements":[]}', ?)`,
  ).run(`v-${diagramId}-${version}`, diagramId, version, NOW)
}

describe('migration 038_diagrams', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyUpTo037(db)
    up038(db)
  })

  afterEach(() => {
    db.close()
  })

  it('cria diagrams com as colunas esperadas', () => {
    const cols = (db.prepare(`PRAGMA table_info(diagrams)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    expect(cols).toEqual([
      'id',
      'title',
      'kind',
      'status',
      'scene',
      'source_format',
      'source',
      'thumbnail',
      'version',
      'created_at',
      'updated_at',
    ])
  })

  it('aplica defaults: kind other, status active, scene vazia, version 1', () => {
    insertDiagram(db)
    const row = db.prepare(`SELECT * FROM diagrams WHERE id = 'd1'`).get() as Record<
      string,
      unknown
    >
    expect(row.kind).toBe('other')
    expect(row.status).toBe('active')
    expect(row.scene).toBe('{"elements":[]}')
    expect(row.version).toBe(1)
    expect(row.source_format).toBeNull()
  })

  it('CHECK rejeita title vazio ou só espaço', () => {
    expect(() => insertDiagram(db, 'd2', '')).toThrow()
    expect(() => insertDiagram(db, 'd3', '   ')).toThrow()
  })

  it('CHECK rejeita kind, status, source_format e author fora dos enums', () => {
    expect(() =>
      db
        .prepare(`INSERT INTO diagrams (id, title, kind, created_at, updated_at) VALUES ('k', 'x', 'wireframe', 1, 1)`)
        .run(),
    ).toThrow()
    expect(() =>
      db
        .prepare(`INSERT INTO diagrams (id, title, status, created_at, updated_at) VALUES ('s', 'x', 'draft', 1, 1)`)
        .run(),
    ).toThrow()
    expect(() =>
      db
        .prepare(`INSERT INTO diagrams (id, title, source_format, created_at, updated_at) VALUES ('f', 'x', 'svg', 1, 1)`)
        .run(),
    ).toThrow()
    insertDiagram(db)
    expect(() =>
      db
        .prepare(
          `INSERT INTO diagram_versions (id, diagram_id, version, author, summary, scene, created_at)
           VALUES ('v', 'd1', 1, 'robot', 'x', '{}', 1)`,
        )
        .run(),
    ).toThrow()
  })

  it('aceita os 11 parent_type e rejeita fora do enum', () => {
    insertDiagram(db)
    const parents = [
      'project',
      'repo',
      'feature',
      'task',
      'objective',
      'key_result',
      'dossier',
      'meeting',
      'content_contract',
      'session',
      'handoff',
    ]
    for (const [i, parentType] of parents.entries()) {
      db.prepare(
        `INSERT INTO diagram_links (diagram_id, parent_type, parent_id) VALUES ('d1', ?, ?)`,
      ).run(parentType, `p-${i}`)
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM diagram_links').get() as { n: number }
    expect(count.n).toBe(11)
    expect(() =>
      db
        .prepare(`INSERT INTO diagram_links (diagram_id, parent_type, parent_id) VALUES ('d1', 'sprint', 'x')`)
        .run(),
    ).toThrow()
  })

  it('PK composta de diagram_links rejeita link duplicado', () => {
    insertDiagram(db)
    db.prepare(
      `INSERT INTO diagram_links (diagram_id, parent_type, parent_id) VALUES ('d1', 'feature', 'f1')`,
    ).run()
    expect(() =>
      db
        .prepare(`INSERT INTO diagram_links (diagram_id, parent_type, parent_id) VALUES ('d1', 'feature', 'f1')`)
        .run(),
    ).toThrow()
  })

  it('UNIQUE(diagram_id, version) rejeita snapshot duplicado', () => {
    insertDiagram(db)
    insertVersion(db, 'd1', 1)
    expect(() => insertVersion(db, 'd1', 1)).toThrow()
  })

  it('FK rejeita versão e link de diagrama inexistente', () => {
    expect(() => insertVersion(db, 'fantasma', 1)).toThrow()
    expect(() =>
      db
        .prepare(`INSERT INTO diagram_links (diagram_id, parent_type, parent_id) VALUES ('fantasma', 'repo', 'r1')`)
        .run(),
    ).toThrow()
  })

  it('apagar o diagrama cascateia versões e links', () => {
    insertDiagram(db)
    insertVersion(db)
    db.prepare(
      `INSERT INTO diagram_links (diagram_id, parent_type, parent_id) VALUES ('d1', 'repo', 'r1')`,
    ).run()

    db.prepare(`DELETE FROM diagrams WHERE id = 'd1'`).run()

    const versions = db.prepare('SELECT COUNT(*) AS n FROM diagram_versions').get() as { n: number }
    const links = db.prepare('SELECT COUNT(*) AS n FROM diagram_links').get() as { n: number }
    expect(versions.n).toBe(0)
    expect(links.n).toBe(0)
    expect(db.pragma('foreign_key_check') as unknown[]).toEqual([])
  })
})
