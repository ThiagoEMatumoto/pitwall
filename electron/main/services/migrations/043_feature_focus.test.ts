import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'

// Aplica a cadeia inteira até a 043 (algumas migrations precisam de
// foreign_keys OFF, igual ao runner real).
function applyAll(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version <= 43)) {
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

function seedFeature(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO features (id, project_id, slug, title, status, doc_path, created_at, updated_at)
     VALUES (?, 'p1', ?, ?, 'active', ?, ?, ?)`,
  ).run(id, id, id, `/tmp/${id}.md`, Date.now(), Date.now())
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  )
}

describe('migration 043_feature_focus', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyAll(db)
    db.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P1', ?, ?)`,
    ).run(Date.now(), Date.now())
    seedFeature(db, 'f1')
  })

  afterEach(() => {
    db.close()
  })

  it('adiciona pinned (default 0), focus_rank, duplicate_of e duplicate_score em features', () => {
    const names = columnNames(db, 'features')
    for (const col of ['pinned', 'focus_rank', 'duplicate_of', 'duplicate_score']) {
      expect(names, `features deveria ter ${col}`).toContain(col)
    }
    const row = db
      .prepare(
        `SELECT pinned, focus_rank, duplicate_of, duplicate_score FROM features WHERE id = 'f1'`,
      )
      .get() as {
      pinned: number
      focus_rank: number | null
      duplicate_of: string | null
      duplicate_score: number | null
    }
    // Row pré-existente (inserida sem citar as colunas novas) herda os defaults.
    expect(row.pinned).toBe(0)
    expect(row.focus_rank).toBeNull()
    expect(row.duplicate_of).toBeNull()
    expect(row.duplicate_score).toBeNull()
  })

  it('pinned é NOT NULL e persiste; focus_rank aceita fração (inserção entre vizinhos)', () => {
    db.prepare(`UPDATE features SET pinned = 1, focus_rank = 1.5 WHERE id = 'f1'`).run()
    const row = db
      .prepare(`SELECT pinned, focus_rank FROM features WHERE id = 'f1'`)
      .get() as { pinned: number; focus_rank: number }
    expect(row.pinned).toBe(1)
    // REAL, não INTEGER: reordenar insere no meio sem renumerar a parede.
    expect(row.focus_rank).toBe(1.5)
    expect(() => db.prepare(`UPDATE features SET pinned = NULL WHERE id = 'f1'`).run()).toThrow(
      /NOT NULL/i,
    )
  })

  it('duplicate_of é FK pra features: candidato inexistente falha', () => {
    seedFeature(db, 'f2')
    expect(() =>
      db
        .prepare(`UPDATE features SET duplicate_of = 'f2', duplicate_score = 0.62 WHERE id = 'f1'`)
        .run(),
    ).not.toThrow()
    expect(() =>
      db.prepare(`UPDATE features SET duplicate_of = 'nao-existe' WHERE id = 'f1'`).run(),
    ).toThrow(/FOREIGN KEY constraint/i)
  })

  it('apagar o candidato zera a suspeita (ON DELETE SET NULL), sem apagar o suspeito', () => {
    seedFeature(db, 'f2')
    db.prepare(
      `UPDATE features SET duplicate_of = 'f2', duplicate_score = 0.62 WHERE id = 'f1'`,
    ).run()
    db.prepare(`DELETE FROM features WHERE id = 'f2'`).run()
    const row = db
      .prepare(`SELECT id, duplicate_of, duplicate_score FROM features WHERE id = 'f1'`)
      .get() as { id: string; duplicate_of: string | null; duplicate_score: number | null }
    // A feature suspeita SOBREVIVE — nada aqui é destrutivo; só o ponteiro cai.
    expect(row.id).toBe('f1')
    expect(row.duplicate_of).toBeNull()
    // O score fica pendurado sem candidato: quem lê exige duplicate_of != NULL.
    expect(row.duplicate_score).toBe(0.62)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})
