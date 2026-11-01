import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

let testDb: Database.Database
const running = vi.hoisted(() => new Set<string>())
vi.mock('./db', () => ({ getDb: () => testDb }))
vi.mock('./pty-manager', () => ({
  ptyManager: { runningIds: () => [...running], getActivitySample: () => null },
}))
vi.mock('./session-activity', () => ({
  buildSessionsFileIndex: () => new Map(),
  isPidAlive: () => false,
  mapStatus: (s: string) => s,
  ptyStatusFor: () => 'idle',
}))

import { applyAllMigrations, seedRepos, seedSession } from './attention/attention-test-harness'
import { tuiMenuWatch } from './tui-menu-watch'
import { liveSessionStates } from './live-session-states'

// Tela real do diálogo de trust (captura do claude): ele vem ANTES de o CLI gravar
// o session file, então a sessão não está no índice.
const FIXTURES = join(__dirname, '../../../shared/tui/__fixtures__')
const fakePty = new EventEmitter() as EventEmitter & { write: () => void }
fakePty.write = () => {}
async function showScreen(sessionId: string, file: string): Promise<void> {
  fakePty.emit('spawn', { sessionId, cols: 80, rows: 24 })
  fakePty.emit('data', { sessionId, data: readFileSync(join(FIXTURES, file), 'utf8') })
  await tuiMenuWatch.snapshot(sessionId)
}

describe('PTY viva sem session file', () => {
  beforeAll(() => tuiMenuWatch.attach(fakePty as never))
  beforeEach(() => {
    testDb = new Database(':memory:')
    applyAllMigrations(testDb)
    seedRepos(testDb)
    seedSession(testDb, 's1')
    running.clear()
    running.add('s1')
  })
  afterEach(() => {
    fakePty.emit('exit', { sessionId: 's1' })
    testDb.close()
  })

  it('parada no diálogo de trust é waiting (precisa de você), não encerrada', async () => {
    await showScreen('s1', 'claude-2.1.286-trust-unnumbered.ansi')
    expect(liveSessionStates(new Map()).get('s1')?.status).toBe('waiting')
  })

  it('sem menu na tela ainda está subindo', () => {
    expect(liveSessionStates(new Map()).get('s1')?.status).toBe('starting')
  })
})
