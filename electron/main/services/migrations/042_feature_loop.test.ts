import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'

// Aplica as migrations 001-041 (algumas precisam de foreign_keys OFF, igual ao
// runner real) e então a 042 sob teste, deixando o schema pronto pra seedar.
function applyAll(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version <= 42)) {
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

describe('migration 042_feature_loop', () => {
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

  it('adiciona cadence_days (nullable) e loop_export (default 1) em features', () => {
    const names = columnNames(db, 'features')
    expect(names).toContain('cadence_days')
    expect(names).toContain('loop_export')
    const row = db
      .prepare(`SELECT cadence_days, loop_export FROM features WHERE id = 'f1'`)
      .get() as { cadence_days: number | null; loop_export: number }
    // NULL = "usa o default de 14 dias", resolvido em código e não no schema.
    expect(row.cadence_days).toBeNull()
    expect(row.loop_export).toBe(1)
  })

  it('cria as 4 tabelas do loop com as colunas declaradas', () => {
    expect(columnNames(db, 'feature_pulses')).toEqual([
      'id',
      'feature_id',
      'body',
      'source',
      'session_id',
      'created_at',
    ])
    expect(columnNames(db, 'feature_ledger')).toEqual([
      'feature_id',
      'entry_id',
      'kind',
      'title',
      'body',
      'created_at',
      'updated_at',
      'archived_at',
    ])
    expect(columnNames(db, 'feature_metrics')).toEqual([
      'feature_id',
      'column_key',
      'label',
      'unit',
      'target',
      'floor',
      'baseline',
      'direction',
      'is_headline',
      'alarm',
    ])
    expect(columnNames(db, 'feature_metric_points')).toEqual([
      'id',
      'feature_id',
      'column_key',
      'at',
      'value',
      'note',
    ])
  })

  it('o pulso vigente é derivado por MAX(created_at); não existe coluna is_current', () => {
    expect(columnNames(db, 'feature_pulses')).not.toContain('is_current')
    const insert = db.prepare(
      `INSERT INTO feature_pulses (id, feature_id, body, source, session_id, created_at)
       VALUES (?, 'f1', ?, ?, ?, ?)`,
    )
    insert.run('p-old', 'pulso antigo', 'human', null, 1000)
    insert.run('p-new', 'pulso novo', 'session', 'sess-1', 2000)
    const current = db
      .prepare(
        `SELECT body FROM feature_pulses WHERE feature_id = 'f1'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { body: string }
    expect(current.body).toBe('pulso novo')
    // session_id sem FK: a sessão pode nem existir, o pulso permanece.
    const orphan = db
      .prepare(`SELECT session_id FROM feature_pulses WHERE id = 'p-new'`)
      .get() as { session_id: string | null }
    expect(orphan.session_id).toBe('sess-1')
  })

  it('CHECK de source rejeita valor fora do enum e aceita os quatro válidos', () => {
    const insert = db.prepare(
      `INSERT INTO feature_pulses (id, feature_id, body, source, created_at)
       VALUES (?, 'f1', 'corpo', ?, ?)`,
    )
    for (const src of ['human', 'session', 'mcp', 'seed']) {
      expect(() => insert.run(`ok-${src}`, src, Date.now())).not.toThrow()
    }
    expect(() => insert.run('bad', 'robot', Date.now())).toThrow(/CHECK constraint failed/i)
  })

  it('CHECK de body rejeita vazio e só-espaço em feature_pulses', () => {
    const insert = db.prepare(
      `INSERT INTO feature_pulses (id, feature_id, body, source, created_at)
       VALUES (?, 'f1', ?, 'human', ?)`,
    )
    expect(() => insert.run('empty', '', Date.now())).toThrow(/CHECK constraint failed/i)
    expect(() => insert.run('blank', '   ', Date.now())).toThrow(/CHECK constraint failed/i)
    expect(() => insert.run('good', ' texto ', Date.now())).not.toThrow()
  })

  it('CHECK de entry_id no ledger é só de comprimento (1..80); formato fica no store', () => {
    const insert = db.prepare(
      `INSERT INTO feature_ledger (feature_id, entry_id, kind, title, body, created_at, updated_at)
       VALUES ('f1', ?, 'change', 'titulo', NULL, ?, ?)`,
    )
    expect(() => insert.run('', Date.now(), Date.now())).toThrow(/CHECK constraint failed/i)
    expect(() => insert.run('x'.repeat(81), Date.now(), Date.now())).toThrow(
      /CHECK constraint failed/i,
    )
    // Formato inválido pro store (começa com '-') passa no banco de propósito.
    expect(() => insert.run('-nao-valido-no-store', Date.now(), Date.now())).not.toThrow()
    expect(() => insert.run('x'.repeat(80), Date.now(), Date.now())).not.toThrow()
  })

  it('PK composta do ledger: mesmo entry_id em features diferentes convive, duplicata na mesma não', () => {
    seedFeature(db, 'f2')
    const insert = db.prepare(
      `INSERT INTO feature_ledger (feature_id, entry_id, title, created_at, updated_at)
       VALUES (?, 'e1', 'titulo', ?, ?)`,
    )
    insert.run('f1', Date.now(), Date.now())
    expect(() => insert.run('f2', Date.now(), Date.now())).not.toThrow()
    expect(() => insert.run('f1', Date.now(), Date.now())).toThrow(/UNIQUE/i)
  })

  it('feature_metrics: CHECK de direction espelha objectives/key_results', () => {
    const insert = db.prepare(
      `INSERT INTO feature_metrics (feature_id, column_key, direction) VALUES ('f1', ?, ?)`,
    )
    for (const d of ['increase', 'decrease', 'maintain']) {
      expect(() => insert.run(`k-${d}`, d)).not.toThrow()
    }
    expect(() => insert.run('k-null', null)).not.toThrow()
    expect(() => insert.run('k-bad', 'sideways')).toThrow(/CHECK constraint failed/i)
    const row = db
      .prepare(`SELECT is_headline, alarm FROM feature_metrics WHERE column_key = 'k-null'`)
      .get() as { is_headline: number; alarm: number }
    expect(row.is_headline).toBe(0)
    expect(row.alarm).toBe(0)
  })

  it('FK COMPOSTA: ponto de métrica sem coluna declarada em feature_metrics falha', () => {
    db.prepare(
      `INSERT INTO feature_metrics (feature_id, column_key) VALUES ('f1', 'protocolos')`,
    ).run()
    const insert = db.prepare(
      `INSERT INTO feature_metric_points (id, feature_id, column_key, at, value)
       VALUES (?, ?, ?, ?, 1)`,
    )
    expect(() => insert.run('pt-ok', 'f1', 'protocolos', 1000)).not.toThrow()
    // column_key não declarada → a FK composta barra.
    expect(() => insert.run('pt-orfao', 'f1', 'inexistente', 1000)).toThrow(
      /FOREIGN KEY constraint/i,
    )
    // O par importa: a column_key existe, mas declarada em OUTRA feature.
    seedFeature(db, 'f2')
    expect(() => insert.run('pt-cross', 'f2', 'protocolos', 1000)).toThrow(
      /FOREIGN KEY constraint/i,
    )
    // UNIQUE(feature_id, column_key, at) impede dois pontos no mesmo instante.
    expect(() => insert.run('pt-dup', 'f1', 'protocolos', 1000)).toThrow(/UNIQUE/i)
  })

  it('apagar a feature cascateia pulses, ledger, metrics e metric_points', () => {
    db.prepare(
      `INSERT INTO feature_pulses (id, feature_id, body, source, created_at)
       VALUES ('pl-1', 'f1', 'vivo', 'human', 1000)`,
    ).run()
    db.prepare(
      `INSERT INTO feature_ledger (feature_id, entry_id, title, created_at, updated_at)
       VALUES ('f1', 'e1', 'mudou', 1000, 1000)`,
    ).run()
    db.prepare(
      `INSERT INTO feature_metrics (feature_id, column_key) VALUES ('f1', 'protocolos')`,
    ).run()
    db.prepare(
      `INSERT INTO feature_metric_points (id, feature_id, column_key, at, value)
       VALUES ('pt-1', 'f1', 'protocolos', 1000, 42)`,
    ).run()

    db.prepare(`DELETE FROM features WHERE id = 'f1'`).run()

    for (const t of [
      'feature_pulses',
      'feature_ledger',
      'feature_metrics',
      'feature_metric_points',
    ]) {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }
      expect(n, `${t} deveria estar vazia após o cascade`).toBe(0)
    }
    // O cascade até feature_metric_points é TRANSITIVO (features →
    // feature_metrics → points) e não deixa violação pendente.
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})

