import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

function insertHandoff(
  db: Database.Database,
  id: string,
  repo: string,
  status: string,
  pendingQuestion: string | null,
  questionAskedAt: number | null,
): void {
  db.prepare(
    `INSERT INTO handoffs (id, target_repo_id, child_session_id, task, composed_prompt, status, mode,
                           pending_question, question_asked_at, created_at, updated_at)
     VALUES (?, ?, ?, 't', 'p', ?, 'interactive', ?, ?, 100, 900)`,
  ).run(id, repo, `child-${id}`, status, pendingQuestion, questionAskedAt)
}

describe('migration 058_handoff_requests', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    apply(db, 0, 57)
    db.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',1,1)`).run()
    db.prepare(
      `INSERT INTO repos (id, project_id, label, path, position, created_at)
       VALUES ('r1','p1','R1','/tmp/r1',0,1), ('r2','p1','R2','/tmp/r2',1,1), ('r3','p1','R3','/tmp/r3',2,1)`,
    ).run()
  })

  afterEach(() => db.close())

  it('is registered as version 58', () => {
    expect(migrations.find((m) => m.version === 58)?.name).toBe('058_handoff_requests')
  })

  it('backfill: só needs_input com pergunta vira request, com o texto empilhado inteiro', () => {
    insertHandoff(db, 'asking', 'r1', 'needs_input', 'a\n\nb', 500)
    insertHandoff(db, 'residual', 'r2', 'running', 'velha', 400)
    insertHandoff(db, 'finished', 'r3', 'done', null, null)
    apply(db, 58, 58)

    const rows = db.prepare('SELECT * FROM handoff_requests').all() as Array<
      Record<string, unknown>
    >
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      handoff_id: 'asking',
      asker_session_id: 'child-asking',
      kind: 'question',
      question: 'a\n\nb',
      resolver: 'mother',
      addressee: 'mother',
      status: 'open',
      options_json: '[]',
      created_at: 500,
    })
    const ev = db
      .prepare("SELECT * FROM handoff_events WHERE event = 'migration_request_backfill'")
      .all() as Array<Record<string, unknown>>
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({
      handoff_id: 'asking',
      from_status: 'needs_input',
      to_status: 'needs_input',
      detail: rows[0].id,
    })
  })

  it('created_at cai pro updated_at quando question_asked_at é NULL', () => {
    insertHandoff(db, 'asking', 'r1', 'needs_input', 'q', null)
    apply(db, 58, 58)
    const row = db.prepare('SELECT created_at FROM handoff_requests').get() as {
      created_at: number
    }
    expect(row.created_at).toBe(900)
  })

  it('cria attention_dismissals e o UNIQUE parcial de idempotency_key', () => {
    apply(db, 58, 58)
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attention_dismissals'").get(),
    ).toBeDefined()
    const ins = db.prepare(
      `INSERT INTO handoff_requests (id, handoff_id, kind, question, resolver, addressee, status, idempotency_key, created_at)
       VALUES (?, 'h', 'question', 'q', 'mother', 'mother', 'open', ?, 1)`,
    )
    ins.run('a', null)
    ins.run('b', null)
    ins.run('c', 'k')
    expect(() => ins.run('d', 'k')).toThrow(/UNIQUE/)
  })
})
