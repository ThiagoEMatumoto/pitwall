/** @vitest-environment node */
// handoffs:fail encerra a filha viva. Store e banco REAIS (SQLite in-memory
// migrado); o único dublê é o killer de PTY — é a fronteira com o processo.
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Handoff } from '../../../shared/types/ipc'
import { migrations } from '../services/migrations/index'

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cm-test-userdata' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, cb: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, cb)
    },
  },
}))

let testDb: Database.Database
vi.mock('../services/db', () => ({ getDb: () => testDb }))
vi.mock('../services/transcript-path', () => ({ findTranscriptPath: () => null }))
vi.mock('../services/notify', () => ({ broadcast: () => {} }))

const live = new Set<string>()
const kills: string[] = []
vi.mock('../services/pty-manager', () => ({
  ptyManager: {
    isRunning: (id: string) => live.has(id),
    kill: (id: string) => {
      kills.push(id)
      live.delete(id)
    },
  },
}))

const store = await import('../services/handoff-store')
const { registerHandoffsIpc } = await import('./handoffs')
registerHandoffsIpc()

function fail(id: string, error = 'Falha forçada manualmente pelo usuário'): Handoff {
  return handlers.get('handoffs:fail')!(null, { id, error }) as Handoff
}

function newHandoff(): Handoff {
  return store.create({ targetRepoId: 'r1', task: 'do thing', composedPrompt: 'prompt' })
}

beforeEach(() => {
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  for (const m of migrations) {
    if (!m.disableForeignKeys) {
      m.up(testDb)
      continue
    }
    testDb.pragma('foreign_keys = OFF')
    try {
      m.up(testDb)
    } finally {
      testDb.pragma('foreign_keys = ON')
    }
  }
  const now = Date.now()
  testDb.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)`).run(now, now)
  testDb
    .prepare(`INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES ('r1','p1','R1','/tmp/r1',0,?)`)
    .run(now)
  live.clear()
  kills.length = 0
})

describe('handoffs:fail', () => {
  it('marca failed e mata a PTY da filha viva', () => {
    const h = newHandoff()
    store.markRunning(h.id, 's-child')
    live.add('s-child')
    const after = fail(h.id)
    expect(after.status).toBe('failed')
    expect(kills).toEqual(['s-child'])
    // failed ANTES do kill: o exit da PTY não pode reconciliar pra interrupted.
    expect(store.failIfRunning(h.id, 'exit')).toBeNull()
    expect(store.get(h.id)!.status).toBe('failed')
  })

  it('falha de spawn (approved, sem filha) não mata nada', () => {
    const h = newHandoff()
    store.approve(h.id, {})
    expect(fail(h.id, 'spawn falhou').status).toBe('failed')
    expect(kills).toEqual([])
  })

  it('handoff já done: recusa e NÃO mata a PTY', () => {
    const h = newHandoff()
    store.markRunning(h.id, 's-child')
    store.report(h.id, 'ok')
    live.add('s-child')
    expect(() => fail(h.id)).toThrow(store.HandoffTransitionError)
    expect(kills).toEqual([])
    expect(store.get(h.id)!.status).toBe('done')
  })
})
