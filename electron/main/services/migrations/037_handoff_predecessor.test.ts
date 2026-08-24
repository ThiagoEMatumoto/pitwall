import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './index'
import { up as up037 } from './037_handoff_predecessor'

// Aplica 001-036 (igual ao runner real, respeitando disableForeignKeys) p/
// deixar o schema pronto ANTES da 037.
function applyUpTo036(db: Database.Database): void {
  for (const m of migrations.filter((m) => m.version < 37)) {
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
}

describe('migration 037_handoff_predecessor', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyUpTo036(db)
    db.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)`).run(
      Date.now(),
      Date.now(),
    )
    db.prepare(
      `INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES ('r1','p1','r1','/tmp/r1',0,?)`,
    ).run(Date.now())
  })

  afterEach(() => {
    db.close()
  })

  it('adiciona predecessor_session_id nullable (linha antiga herda NULL)', () => {
    const now = Date.now()
    db.prepare(
      `INSERT INTO handoffs (id, target_repo_id, task, composed_prompt, status, created_at, updated_at)
       VALUES ('h1','r1','t','p','running',?,?)`,
    ).run(now, now)

    up037(db)

    const names = (db.prepare(`PRAGMA table_info(handoffs)`).all() as ColumnInfo[]).map(
      (c) => c.name,
    )
    expect(names).toContain('predecessor_session_id')

    const row = db.prepare('SELECT predecessor_session_id FROM handoffs WHERE id = ?').get('h1') as {
      predecessor_session_id: string | null
    }
    expect(row.predecessor_session_id).toBeNull()
  })

  // A passagem de bastão relinka child_session_id pra sucessora; a antecessora só
  // continua rastreável se as duas colunas coexistirem na MESMA linha.
  it('guarda antecessora e sucessora lado a lado no mesmo handoff', () => {
    const now = Date.now()
    db.prepare(
      `INSERT INTO handoffs (id, target_repo_id, task, composed_prompt, status, child_session_id, created_at, updated_at)
       VALUES ('h2','r1','t','p','running','sess-antiga',?,?)`,
    ).run(now, now)
    up037(db)

    db.prepare(
      'UPDATE handoffs SET child_session_id = ?, predecessor_session_id = ? WHERE id = ?',
    ).run('sess-nova', 'sess-antiga', 'h2')

    const row = db
      .prepare('SELECT child_session_id, predecessor_session_id FROM handoffs WHERE id = ?')
      .get('h2') as { child_session_id: string; predecessor_session_id: string }
    expect(row.child_session_id).toBe('sess-nova')
    expect(row.predecessor_session_id).toBe('sess-antiga')
  })

  // Linhagem não é FK: a antecessora pode ser removida do histórico de sessões e o
  // handoff continua válido (mesma escolha de child_session_id/from_repo_id).
  it('aceita id de sessão inexistente (sem FK enforced)', () => {
    const now = Date.now()
    db.prepare(
      `INSERT INTO handoffs (id, target_repo_id, task, composed_prompt, status, created_at, updated_at)
       VALUES ('h3','r1','t','p','running',?,?)`,
    ).run(now, now)
    up037(db)

    expect(() =>
      db
        .prepare('UPDATE handoffs SET predecessor_session_id = ? WHERE id = ?')
        .run('sessao-que-nao-existe', 'h3'),
    ).not.toThrow()
  })
})
