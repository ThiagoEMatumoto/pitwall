import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let testDb: Database.Database
const running = new Set<string>()
const inbound = new Set<string>()
const status = new Map<string, string>()
let turnEnded: ((cc: string) => void) | null = null
const broadcasts: Array<[string, unknown]> = []

vi.mock('../db', () => ({ getDb: () => testDb }))
vi.mock('../notify', () => ({ broadcast: (c: string, p: unknown) => broadcasts.push([c, p]) }))
vi.mock('../transcript-path', () => ({ findTranscriptPath: () => '/tmp/t.jsonl' }))
vi.mock('../pty-manager', () => ({ ptyManager: { isRunning: (id: string) => running.has(id) } }))
vi.mock('../session-settings', () => ({
  acceptsCrossSessionInbound: (id: string) => inbound.has(id),
}))
vi.mock('../session-activity', () => ({
  buildSessionsFileIndex: () => new Map(),
  onTurnEnded: (fn: (cc: string) => void) => {
    turnEnded = fn
    return () => {}
  },
}))
vi.mock('../live-session-states', () => ({
  liveSessionStates: () => new Map([...status].map(([id, s]) => [id, { status: s }])),
}))
const killed: string[] = []
vi.mock('./kill-and-wait', () => ({
  killAndWaitExit: async (id: string) => {
    killed.push(id)
    running.delete(id)
  },
}))
const resumed: string[] = []
vi.mock('../../ipc/sessions', () => ({
  resumeConversation: (input: { ccSessionId: string }) => {
    resumed.push(input.ccSessionId)
    return { session: { id: 'novo' }, reattached: false }
  },
}))

import * as store from '../handoff-store'
import { applyAllMigrations, seedRepos, seedSession } from '../attention/attention-test-harness'
import { readMotherPinKeys } from '../mother-pins-store'
import { promoteInDb, promoteToMother } from './promote'

function ccOf(id: string): string {
  return (testDb.prepare('SELECT cc_session_id FROM sessions WHERE id = ?').get(id) as {
    cc_session_id: string
  }).cc_session_id
}

function dispatch(mother: string, child: string, repo: string): string {
  const h = store.create({ motherSessionId: mother, targetRepoId: repo, task: 't', composedPrompt: 'p' })
  store.markRunning(h.id, child)
  return h.id
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('Tornar mãe', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    seedRepos(testDb)
    seedSession(testDb, 'avo', { repoId: 'r1' })
    seedSession(testDb, 'filha', { repoId: 'r2' })
    seedSession(testDb, 'neta', { repoId: 'r3' })
    running.clear()
    inbound.clear()
    status.clear()
    killed.length = 0
    resumed.length = 0
    broadcasts.length = 0
  })
  afterEach(() => testDb.close())

  it('solta a filha, traz as netas das linhas antigas, fixa e limpa o handoffChild', () => {
    const own = dispatch('avo', 'filha', 'r2')
    // A filha foi retomada: a neta ainda é liderada pela linha antiga.
    testDb
      .prepare(
        `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at, spawn_args)
         VALUES ('filha-2','r2',?, 'running', 9, '{"handoffChild":true,"model":null}')`,
      )
      .run(ccOf('filha'))
    const netaH = dispatch('filha', 'neta', 'r3')

    const r = promoteInDb('filha-2')
    expect(r.released).toBe(1)
    expect(r.transferred).toBe(1)
    expect(store.get(own)!.childSessionId).toBeNull()
    expect(store.getByChildConversation('filha-2')).toBeNull()
    expect(store.get(netaH)!.motherSessionId).toBe('filha-2')
    expect(readMotherPinKeys(testDb).has(ccOf('filha'))).toBe(true)
    const sa = testDb.prepare(`SELECT spawn_args FROM sessions WHERE id = 'filha-2'`).get() as {
      spawn_args: string
    }
    expect(JSON.parse(sa.spawn_args).handoffChild).toBe(false)
    expect(broadcasts.some(([c]) => c === 'mother-pins:updated')).toBe(true)
  })

  it('sem exec de filha não reinicia', () => {
    dispatch('avo', 'filha', 'r2')
    running.add('filha')
    expect(promoteToMother({ sessionId: 'filha', restart: 'when-idle' }).restart).toBe('not-needed')
    expect(killed).toEqual([])
  })

  it('trabalhando: agenda e só relança no fim do turno', async () => {
    dispatch('avo', 'filha', 'r2')
    running.add('filha')
    inbound.add('filha')
    status.set('filha', 'working')
    expect(promoteToMother({ sessionId: 'filha', restart: 'when-idle' }).restart).toBe('scheduled')
    expect(killed).toEqual([])
    turnEnded!('outra-conversa')
    expect(killed).toEqual([])
    turnEnded!(ccOf('filha'))
    await flush()
    expect(killed).toEqual(['filha'])
    expect(resumed).toEqual([ccOf('filha')])
    expect(broadcasts).toContainEqual([
      'mother-pins:restart',
      { sessionId: 'filha', state: 'restarted', newSessionId: 'novo' },
    ])
  })

  it('ociosa ou "Reiniciar agora": relança na hora', async () => {
    dispatch('avo', 'filha', 'r2')
    running.add('filha')
    inbound.add('filha')
    status.set('filha', 'working')
    expect(promoteToMother({ sessionId: 'filha', restart: 'now' }).restart).toBe('restarting')
    await flush()
    expect(killed).toEqual(['filha'])
  })
})
