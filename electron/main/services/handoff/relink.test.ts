import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../migrations/index'

// Store REAL num SQLite migrado (o produtor do vínculo); só PTY e broadcast são
// do teste — o que se quer provar é que nada é relançado nem duplicado.
let testDb: Database.Database
vi.mock('../db', () => ({ getDb: () => testDb, handoffsInterruptedAtOpen: () => [] }))
vi.mock('../transcript-path', () => ({ findTranscriptPath: () => null }))
const broadcasts: string[] = []
vi.mock('../notify', () => ({ broadcast: (ch: string) => broadcasts.push(ch) }))
const running = new Set<string>()
const kills: string[] = []
vi.mock('../pty-manager', () => ({
  ptyManager: {
    isRunning: (id: string) => running.has(id),
    kill: (id: string) => kills.push(id),
  },
}))

import * as store from '../handoff-store'
import { childLink, detachChild, relinkChild, setChildMother } from './relink'

function migrate(db: Database.Database): void {
  for (const m of migrations) {
    if (m.disableForeignKeys) db.pragma('foreign_keys = OFF')
    try {
      m.up(db)
    } finally {
      if (m.disableForeignKeys) db.pragma('foreign_keys = ON')
    }
  }
}

function addSession(id: string, cc: string): void {
  testDb
    .prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at)
       VALUES (?, 'r1', ?, 'running', ?)`,
    )
    .run(id, cc, Date.now())
}

function dispatch(mother: string, child: string): string {
  const h = store.create({
    motherSessionId: mother,
    targetRepoId: 'r1',
    task: 't',
    composedPrompt: 'p',
  })
  store.markRunning(h.id, child)
  return h.id
}

describe('relink de filha (sem relançar, sem handoff novo)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    migrate(testDb)
    testDb
      .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P',1,1)`)
      .run()
    testDb
      .prepare(
        `INSERT INTO repos (id, project_id, label, path, position, created_at)
         VALUES ('r1','p1','R','/tmp/r1',0,1)`,
      )
      .run()
    addSession('mae', 'cc-mae')
    addSession('mae-b', 'cc-mae-b')
    addSession('kid', 'cc-kid')
    running.clear()
    kills.length = 0
    broadcasts.length = 0
  })

  afterEach(() => testDb.close())

  it('interrompida + dispensada e viva: re-vincula o mesmo handoff, sem kill', () => {
    const id = dispatch('mae', 'kid')
    store.failIfRunning(id, 'caiu')
    store.dismiss(id)
    running.add('kid')
    expect(childLink('kid').state).toBe('relinkable')

    const out = relinkChild({ sessionId: 'kid', motherSessionId: 'mae-b' })

    expect(out).toMatchObject({
      id,
      status: 'running',
      dismissedAt: null,
      motherSessionId: 'mae-b',
    })
    expect(store.list()).toHaveLength(1)
    expect(kills).toEqual([])
    expect(broadcasts).toContain('handoff:updated')
    expect(childLink('kid').state).toBe('active')
  })

  it('linha retomada por fora do relink (mesmo cc) re-vincula apontando pra ela', () => {
    const id = dispatch('mae', 'kid')
    store.dismiss(id)
    addSession('kid-2', 'cc-kid')
    running.add('kid-2')

    expect(relinkChild({ sessionId: 'kid-2' }).childSessionId).toBe('kid-2')
  })

  it('sem vínculo: recusa e aponta pra adoção', () => {
    expect(childLink('kid').state).toBe('none')
    expect(() => relinkChild({ sessionId: 'kid' })).toThrow(/Tornar sessão filha/)
  })

  it('trocar mãe de uma filha e desvincular', () => {
    const id = dispatch('mae', 'kid')
    expect(setChildMother({ handoffId: id, motherSessionId: 'mae-b' }).motherSessionId).toBe(
      'mae-b',
    )
    expect(() => setChildMother({ handoffId: id, motherSessionId: 'nao-existe' })).toThrow(
      /não encontrada/,
    )

    const released = detachChild({ sessionId: 'kid' })
    expect(released.childSessionId).toBeNull()
    expect(childLink('kid').state).toBe('none')
  })
})
