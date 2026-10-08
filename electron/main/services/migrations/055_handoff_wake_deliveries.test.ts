import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrations } from './index'

function apply(db: Database.Database, from: number, upTo: number): void {
  for (const m of migrations.filter((x) => x.version >= from && x.version <= upTo)) {
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

describe('migration 055_handoff_wake_deliveries', () => {
  const open: Database.Database[] = []
  afterEach(() => open.splice(0).forEach((d) => d.close()))

  it('is registered as version 55', () => {
    expect(migrations.find((m) => m.version === 55)?.name).toBe('055_handoff_wake_deliveries')
  })

  it('cria a tabela com as 12 colunas e os 4 índices', () => {
    const db = new Database(':memory:')
    open.push(db)
    apply(db, 1, 55)
    const cols = (db.pragma('table_info(handoff_wake_deliveries)') as Array<{ name: string }>).map(
      (c) => c.name,
    )
    expect(cols).toEqual([
      'id',
      'wake_id',
      'handoff_id',
      'mother_session_id',
      'reason',
      'outcome',
      'detail',
      'created_at',
      'held_at',
      'delivered_at',
      'finished_at',
      'fetched_at',
    ])
    const idx = (db.pragma('index_list(handoff_wake_deliveries)') as Array<{ name: string }>)
      .map((i) => i.name)
      .filter((n) => n.startsWith('idx_'))
      .sort()
    expect(idx).toEqual([
      'idx_wake_deliveries_handoff',
      'idx_wake_deliveries_mother',
      'idx_wake_deliveries_outcome',
      'idx_wake_deliveries_wake',
    ])
  })

  it('é aditiva: banco 054 com handoff existente aplica sem falhar', () => {
    const db = new Database(':memory:')
    open.push(db)
    apply(db, 1, 54)
    db.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',1,1)`,
    ).run()
    db.prepare(
      `INSERT INTO repos (id, project_id, label, path, position, created_at)
       VALUES ('r1','p1','R1','/tmp/r1',0,1)`,
    ).run()
    // Mesmo INSERT legado do teste da 054.
    db.prepare(
      `INSERT INTO handoffs (id, target_repo_id, task, composed_prompt, status, mode, created_at, updated_at, dismissed_at)
       VALUES ('h1', 'r1', 't', 'p', 'running', 'plan', 1, 1, NULL)`,
    ).run()
    expect(() => apply(db, 55, 55)).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM handoffs').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM handoff_wake_deliveries').get()).toEqual({ n: 0 })
  })
})
