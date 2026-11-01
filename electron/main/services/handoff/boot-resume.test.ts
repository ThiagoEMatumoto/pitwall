import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let testDb: Database.Database
const transcripts = vi.hoisted(() => new Set<string>())
vi.mock('../db', () => ({ getDb: () => testDb, handoffsInterruptedAtOpen: () => [] }))
vi.mock('../transcript-path', () => ({
  findTranscriptPath: (cc: string) => (transcripts.has(cc) ? `/t/${cc}.jsonl` : null),
}))

import * as store from '../handoff-store'
import { applyAllMigrations, seedRepos, seedSession } from '../attention/attention-test-harness'
import { resumeSweptChildren } from './boot-resume'

function ccOf(id: string): string {
  return (testDb.prepare('SELECT cc_session_id FROM sessions WHERE id = ?').get(id) as {
    cc_session_id: string
  }).cc_session_id
}

// O sweep do getDb no boot: em voo → interrupted (a PTY morreu com o app).
function sweep(): string[] {
  const ids = (
    testDb.prepare("SELECT id FROM handoffs WHERE status IN ('running','needs_input')").all() as Array<{
      id: string
    }>
  ).map((r) => r.id)
  testDb.prepare("UPDATE handoffs SET status = 'interrupted' WHERE status IN ('running','needs_input')").run()
  return ids
}

const repoOf: Record<string, string> = { f1: 'r2', f2: 'r3', f3: 'r4', f4: 'r5' }

function dispatch(child: string): string {
  const h = store.create({
    motherSessionId: 'mae',
    targetRepoId: repoOf[child],
    task: 't',
    composedPrompt: 'p',
  })
  store.markRunning(h.id, child)
  transcripts.add(ccOf(child))
  return h.id
}

// Filha que rodava sem aba quando o app fechou: a lazy restore só sobe quem tinha
// pane. Sem isto ela voltava "interrompida" embora estivesse viva antes do restart.
describe('boot: filhas em voo sem aba voltam vivas', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyAllMigrations(testDb)
    seedRepos(testDb)
    for (const id of ['mae', 'f1', 'f2', 'f3', 'f4']) seedSession(testDb, id, { repoId: 'r2' })
    transcripts.clear()
  })
  afterEach(() => testDb.close())

  it('retoma as em voo com transcript; pula dispensada, solta, sem transcript e já encerrada antes', () => {
    const live = dispatch('f1')
    const dismissed = dispatch('f2')
    store.dismiss(dismissed)
    const noTranscript = dispatch('f3')
    transcripts.delete(ccOf('f3'))
    const done = dispatch('f4')
    store.report(done, 'ok')
    const swept = sweep()
    const resume = vi.fn()
    expect(resumeSweptChildren(swept, resume)).toEqual([live])
    expect(resume).toHaveBeenCalledWith(live, { origin: 'main' })
    expect(resume).toHaveBeenCalledTimes(1)
    void noTranscript
  })

  it('falha ao retomar uma não impede as outras', () => {
    const a = dispatch('f1')
    const b = dispatch('f2')
    const swept = sweep()
    const resume = vi.fn((id: string) => {
      if (id === a) throw new Error('boom')
    })
    expect(resumeSweptChildren(swept, resume)).toEqual([b])
  })
})
