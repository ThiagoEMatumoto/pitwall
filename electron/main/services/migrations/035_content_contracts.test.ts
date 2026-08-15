import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'
import { up as up035 } from './035_content_contracts'

// Aplica 001-034 (igual ao runner real, respeitando disableForeignKeys) p/
// deixar o schema pronto ANTES da 035.
function applyUpTo034(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 35)) {
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

function insertContract(db: Database.Database, id = 'c1', slug = 'briefing-inss', label = 'v1'): void {
  db.prepare(
    `INSERT INTO content_contracts (id, slug, title, output_label, created_at, updated_at)
     VALUES (?, ?, 'Briefing INSS', ?, ?, ?)`,
  ).run(id, slug, label, NOW, NOW)
}

function insertVersion(db: Database.Database, contractId = 'c1', version = 1): void {
  db.prepare(
    `INSERT INTO content_contract_versions
       (id, contract_id, version, summary, reason, changed_fields, snapshot_json, created_at)
     VALUES (?, ?, ?, 'versão inicial', 'criação', '[]', '{}', ?)`,
  ).run(`v-${contractId}-${version}`, contractId, version, NOW)
}

describe('migration 035_content_contracts', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyUpTo034(db)
    up035(db)
  })

  afterEach(() => {
    db.close()
  })

  it('cria content_contracts com as colunas esperadas', () => {
    const cols = (
      db.prepare(`PRAGMA table_info(content_contracts)`).all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(cols).toEqual([
      'id',
      'slug',
      'title',
      'status',
      'version',
      'output_label',
      'audience',
      'ethical_line',
      'allowed_facts',
      'forbidden_facts',
      'out_of_scope',
      'tone',
      'delivery_limits',
      'source_precedence',
      'production_invariants',
      'created_at',
      'updated_at',
    ])
  })

  it('foreign_key_check fica limpo com contrato + versão + gate run', () => {
    insertContract(db)
    insertVersion(db)
    db.prepare(
      `INSERT INTO content_gate_runs
         (id, contract_id, contract_version, gate, status, findings, created_at)
       VALUES ('g1', 'c1', 1, 'tone-lint', 'failed', '{"findings":[],"truncated":false}', ?)`,
    ).run(NOW)

    expect(db.pragma('foreign_key_check') as unknown[]).toEqual([])
  })

  it('rejeita gate fora do enum de 6 valores', () => {
    insertContract(db)
    insertVersion(db)
    expect(() =>
      db
        .prepare(
          `INSERT INTO content_gate_runs (id, contract_id, contract_version, gate, status, created_at)
           VALUES ('g2', 'c1', 1, 'nao-existe', 'failed', ?)`,
        )
        .run(NOW),
    ).toThrow()
  })

  it('aceita os 6 gates do registry', () => {
    insertContract(db)
    insertVersion(db)
    const gates = [
      'tone-lint',
      'forbidden-facts',
      'scope',
      'scope-checklist',
      'delivery-limit',
      'positive-evidence',
    ]
    for (const [i, gate] of gates.entries()) {
      db.prepare(
        `INSERT INTO content_gate_runs (id, contract_id, contract_version, gate, status, created_at)
         VALUES (?, 'c1', 1, ?, 'passed', ?)`,
      ).run(`g-${i}`, gate, NOW)
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM content_gate_runs').get() as { n: number }
    expect(count.n).toBe(6)
  })

  it('UNIQUE(contract_id, version) rejeita duplicata', () => {
    insertContract(db)
    insertVersion(db, 'c1', 1)
    expect(() => insertVersion(db, 'c1', 1)).toThrow()
  })

  it('CHECK rejeita output_label vazio ou só espaço', () => {
    expect(() => insertContract(db, 'c2', 'vazio', '')).toThrow()
    expect(() => insertContract(db, 'c3', 'espaco', '   ')).toThrow()
  })

  it('FK composta rejeita gate run contra versão nunca snapshotada', () => {
    insertContract(db)
    insertVersion(db, 'c1', 1)
    expect(() =>
      db
        .prepare(
          `INSERT INTO content_gate_runs (id, contract_id, contract_version, gate, status, created_at)
           VALUES ('g9', 'c1', 7, 'scope', 'failed', ?)`,
        )
        .run(NOW),
    ).toThrow()
  })

  it('apagar o contrato cascateia versões e gate runs', () => {
    insertContract(db)
    insertVersion(db)
    db.prepare(
      `INSERT INTO content_gate_runs (id, contract_id, contract_version, gate, status, created_at)
       VALUES ('g1', 'c1', 1, 'scope', 'passed', ?)`,
    ).run(NOW)

    db.prepare(`DELETE FROM content_contracts WHERE id = 'c1'`).run()

    const versions = db.prepare('SELECT COUNT(*) AS n FROM content_contract_versions').get() as {
      n: number
    }
    const runs = db.prepare('SELECT COUNT(*) AS n FROM content_gate_runs').get() as { n: number }
    expect(versions.n).toBe(0)
    expect(runs.n).toBe(0)
    expect(db.pragma('foreign_key_check') as unknown[]).toEqual([])
  })
})
