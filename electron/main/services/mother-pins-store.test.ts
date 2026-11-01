import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from './migrations'
import { applyAllMigrations, seedRepos, seedSession } from './attention/attention-test-harness'
import {
  importMotherPins,
  listMotherPins,
  motherPinKeyOf,
  readMotherPinKeys,
  setMotherPin,
} from './mother-pins-store'

describe('067_mother_pins + mother-pins-store', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyAllMigrations(db)
    seedRepos(db)
  })
  afterEach(() => db.close())

  it('registrada logo depois da 066', () => {
    const versions = migrations.map((m) => m.version)
    expect(versions.indexOf(67)).toBe(versions.indexOf(66) + 1)
  })

  it('a chave é a conversa: a linha retomada (id novo, mesmo cc) herda o pin', () => {
    seedSession(db, 'm1')
    const cc = (db.prepare('SELECT cc_session_id FROM sessions WHERE id = ?').get('m1') as {
      cc_session_id: string
    }).cc_session_id
    db.prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES ('m1b','r1',?, 'running', 2)`,
    ).run(cc)
    setMotherPin(motherPinKeyOf('m1', db)!, true, db)
    expect(motherPinKeyOf('m1b', db)).toBe(cc)
    expect(readMotherPinKeys(db).has(cc)).toBe(true)
  })

  it('sem cc_session_id cai no sessions.id; sessão inexistente dá null', () => {
    db.prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at) VALUES ('codex','r1',NULL,'running',1)`,
    ).run()
    expect(motherPinKeyOf('codex', db)).toBe('codex')
    expect(motherPinKeyOf('nope', db)).toBeNull()
  })

  it('marcar de novo preserva a ordem; desmarcar remove', () => {
    expect(setMotherPin('a', true, db, 10)).toBe(true)
    expect(setMotherPin('b', true, db, 20)).toBe(true)
    expect(setMotherPin('a', true, db, 30)).toBe(false)
    expect(listMotherPins(db).map((p) => p.key)).toEqual(['a', 'b'])
    expect(setMotherPin('a', false, db)).toBe(true)
    expect(listMotherPins(db).map((p) => p.key)).toEqual(['b'])
  })

  it('import one-shot só acrescenta, na ordem dada', () => {
    setMotherPin('b', true, db, 1)
    expect(importMotherPins(['x', 'b', 'y', ' '], db, 100)).toBe(2)
    expect(listMotherPins(db).map((p) => p.key)).toEqual(['b', 'x', 'y'])
  })
})
