/** @vitest-environment node */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './migrations/index'

// Mesmo padrão de loop-store.test: getDb mockado pra um SQLite in-memory migrado.
let testDb: Database.Database
vi.mock('./db', () => ({
  getDb: () => testDb,
}))

import * as focus from './feature-focus'
import { loopSnapshot } from './loop-snapshot'

function applyAllMigrations(db: Database.Database): void {
  for (const m of migrations) {
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

function seedFeature(id: string, title = id, updatedAt = Date.now()): void {
  testDb
    .prepare(
      `INSERT INTO features
         (id, project_id, slug, title, status, objective, doc_path, synth_mode, origin,
          created_at, updated_at)
       VALUES (?, 'proj-1', ?, ?, 'in-progress', 'Objetivo', ?, 'threshold', 'manual', ?, ?)`,
    )
    .run(id, id, title, `/tmp/${id}.md`, updatedAt, updatedAt)
}

function updatedAtOf(id: string): number {
  return (testDb.prepare('SELECT updated_at AS at FROM features WHERE id = ?').get(id) as {
    at: number
  }).at
}

beforeEach(() => {
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  applyAllMigrations(testDb)
  const now = Date.now()
  testDb
    .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('proj-1', 'Projeto', now, now)
  seedFeature('feat-1', 'Login social')
  seedFeature('feat-2', 'Login social v2')
})

afterEach(() => {
  testDb.close()
})

describe('setFocus / readFocus', () => {
  it('nasce sem foco e o pin persiste', () => {
    expect(focus.readFocus('feat-1')).toEqual({
      featureId: 'feat-1',
      pinned: false,
      focusRank: null,
    })
    expect(focus.setFocus('feat-1', { pinned: true })).toEqual({
      featureId: 'feat-1',
      pinned: true,
      focusRank: null,
    })
    expect(focus.readFocus('feat-1').pinned).toBe(true)
    focus.setFocus('feat-1', { pinned: false })
    expect(focus.readFocus('feat-1').pinned).toBe(false)
  })

  it('é patch parcial: mexer no rank não desfixa, e vice-versa', () => {
    focus.setFocus('feat-1', { pinned: true })
    focus.setFocus('feat-1', { focusRank: 2.5 })
    expect(focus.readFocus('feat-1')).toEqual({
      featureId: 'feat-1',
      pinned: true,
      focusRank: 2.5,
    })
    focus.setFocus('feat-1', { pinned: false })
    expect(focus.readFocus('feat-1').focusRank).toBe(2.5)
    // null EXPLÍCITO limpa a posição (diferente de campo ausente).
    focus.setFocus('feat-1', { focusRank: null })
    expect(focus.readFocus('feat-1').focusRank).toBeNull()
  })

  it('fixar NÃO conta como atividade (não bumpa updated_at)', () => {
    const before = updatedAtOf('feat-1')
    focus.setFocus('feat-1', { pinned: true, focusRank: 1 })
    // Se bumpasse, uma frente abandonada pareceria viva só por ter sido fixada.
    expect(updatedAtOf('feat-1')).toBe(before)
  })

  it('feature inexistente estoura em vez de gravar no vazio', () => {
    expect(() => focus.readFocus('nao-existe')).toThrow(/feature not found/)
    expect(() => focus.setFocus('nao-existe', { pinned: true })).toThrow(/feature not found/)
  })
})

describe('suspeita de duplicata', () => {
  it('marca, resolve o título do candidato e dispensa', () => {
    expect(focus.duplicateSuspectOf('feat-2')).toBeNull()
    focus.markDuplicateSuspect('feat-2', 'feat-1', 0.62)
    expect(focus.duplicateSuspectOf('feat-2')).toEqual({
      candidateId: 'feat-1',
      title: 'Login social',
      score: 0.62,
    })
    focus.clearDuplicateSuspect('feat-2')
    expect(focus.duplicateSuspectOf('feat-2')).toBeNull()
  })

  it('ignora auto-suspeita e não bumpa updated_at', () => {
    const before = updatedAtOf('feat-2')
    focus.markDuplicateSuspect('feat-2', 'feat-2', 0.9)
    expect(focus.duplicateSuspectOf('feat-2')).toBeNull()
    expect(updatedAtOf('feat-2')).toBe(before)
  })

  it('o snapshot expõe pin, rank, o candidato e a issue duplicate_suspect', () => {
    focus.setFocus('feat-2', { pinned: true, focusRank: 3 })
    focus.markDuplicateSuspect('feat-2', 'feat-1', 0.62)
    const snap = loopSnapshot('feat-2')
    expect(snap.pinned).toBe(true)
    expect(snap.focusRank).toBe(3)
    expect(snap.duplicateSuspect).toEqual({
      candidateId: 'feat-1',
      title: 'Login social',
      score: 0.62,
    })
    const issue = snap.issues.find((i) => i.code === 'duplicate_suspect')
    expect(issue?.level).toBe('warn')
    expect(issue?.message).toContain('«Login social»')
    // Aviso, não erro: a feature suspeita não vira 'broken'.
    expect(snap.liveness).not.toBe('broken')
  })

  it('sem suspeita o snapshot não inventa a issue', () => {
    const snap = loopSnapshot('feat-2')
    expect(snap.duplicateSuspect).toBeNull()
    expect(snap.issues.map((i) => i.code)).not.toContain('duplicate_suspect')
  })
})

describe('mergeDuplicate', () => {
  function seedSession(id: string, featureId: string): void {
    testDb
      .prepare(
        `INSERT INTO sessions (id, repo_id, status, started_at, feature_id)
         VALUES (?, 'r1', 'exited', ?, ?)`,
      )
      .run(id, Date.now(), featureId)
  }

  beforeEach(() => {
    testDb
      .prepare(
        `INSERT INTO repos (id, project_id, label, path, position, created_at)
         VALUES ('r1', 'proj-1', 'r1', '/tmp/r1', 0, ?)`,
      )
      .run(Date.now())
    testDb
      .prepare(
        `INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path)
         VALUES ('feat-2', 'r1', 'feat/x', NULL)`,
      )
      .run()
    seedSession('sess-1', 'feat-2')
    testDb
      .prepare(
        `INSERT INTO feature_session_records
           (session_id, feature_id, cc_session_id, summary, session_at, created_at)
         VALUES ('sess-1', 'feat-2', 'cc-1', 'resumo', ?, ?)`,
      )
      .run(Date.now(), Date.now())
    focus.setFocus('feat-2', { pinned: true })
    focus.markDuplicateSuspect('feat-2', 'feat-1', 0.62)
  })

  it('move sessões, registros e repos pro destino e ARQUIVA a origem', () => {
    focus.mergeDuplicate('feat-2', 'feat-1')

    const session = testDb
      .prepare(`SELECT feature_id FROM sessions WHERE id = 'sess-1'`)
      .get() as { feature_id: string }
    expect(session.feature_id).toBe('feat-1')
    const record = testDb
      .prepare(`SELECT feature_id FROM feature_session_records WHERE session_id = 'sess-1'`)
      .get() as { feature_id: string }
    expect(record.feature_id).toBe('feat-1')
    const repos = testDb
      .prepare(`SELECT feature_id FROM feature_repos WHERE repo_id = 'r1' ORDER BY feature_id`)
      .all() as Array<{ feature_id: string }>
    expect(repos.map((r) => r.feature_id)).toEqual(['feat-1', 'feat-2'])

    const source = testDb
      .prepare(
        `SELECT archived_at, pinned, duplicate_of, duplicate_score FROM features WHERE id = 'feat-2'`,
      )
      .get() as {
      archived_at: number | null
      pinned: number
      duplicate_of: string | null
      duplicate_score: number | null
    }
    // Arquiva, nunca apaga: a row (e o histórico por trás dela) continua lá.
    expect(source.archived_at).toBeGreaterThan(0)
    expect(source.pinned).toBe(0)
    expect(source.duplicate_of).toBeNull()
    expect(source.duplicate_score).toBeNull()
  })

  it('o destino sobe updated_at (absorveu trabalho) e o repo já adotado não duplica', () => {
    testDb
      .prepare(
        `INSERT INTO feature_repos (feature_id, repo_id, branch, worktree_path)
         VALUES ('feat-1', 'r1', 'main', NULL)`,
      )
      .run()
    const before = updatedAtOf('feat-1')
    focus.mergeDuplicate('feat-2', 'feat-1')
    expect(updatedAtOf('feat-1')).toBeGreaterThanOrEqual(before)
    const { n } = testDb
      .prepare(
        `SELECT COUNT(*) AS n FROM feature_repos WHERE feature_id = 'feat-1' AND repo_id = 'r1'`,
      )
      .get() as { n: number }
    expect(n).toBe(1)
  })

  it('recusa mesclar consigo mesma ou com feature inexistente', () => {
    expect(() => focus.mergeDuplicate('feat-1', 'feat-1')).toThrow(/itself/)
    expect(() => focus.mergeDuplicate('feat-2', 'nao-existe')).toThrow(/feature not found/)
    // Nada foi movido pela tentativa que falhou.
    const session = testDb
      .prepare(`SELECT feature_id FROM sessions WHERE id = 'sess-1'`)
      .get() as { feature_id: string }
    expect(session.feature_id).toBe('feat-2')
  })
})
