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
import { ORPHANED_AT_BOOT_ERROR, sweepInFlightHandoffs } from './boot-sweep'

function ccOf(id: string): string {
  return (testDb.prepare('SELECT cc_session_id FROM sessions WHERE id = ?').get(id) as {
    cc_session_id: string
  }).cc_session_id
}

// O sweep do getDb no boot: em voo → interrupted (a PTY morreu com o app).
function sweep(): string[] {
  return sweepInFlightHandoffs(testDb)
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

  // Encerrada na janela do Desfazer e o app fechou: o sweep a deixa 'interrupted'
  // como qualquer filha em voo, e é a marca que impede o boot de ressuscitá-la.
  it('encerrada pelo usuário não volta viva; a em segundo plano volta; as duas seguem vinculadas', () => {
    const background = dispatch('f1')
    const ended = dispatch('f2')
    store.setEndedByUser(ended, true)
    const swept = sweep()
    const resume = vi.fn()

    expect(resumeSweptChildren(swept, resume)).toEqual([background])
    expect(resume).toHaveBeenCalledTimes(1)
    expect(store.get(ended)?.childSessionId).toBe('f2')
    expect(store.get(ended)?.resumable).toBe(true)
  })

  // O app fechou na janela do Desfazer: a PTY morre sem passar pelo exit handler,
  // então é o sweep que grava o motivo que a mãe lê.
  it('o sweep grava "encerrada pelo usuário" na filha marcada e "órfã" nas outras', () => {
    const background = dispatch('f1')
    const ended = dispatch('f2')
    store.setEndedByUser(ended, true)
    const asking = dispatch('f3')
    store.ask(asking, 'pergunta')
    store.setEndedByUser(asking, true)
    const undone = dispatch('f4')
    store.setEndedByUser(undone, true)
    store.setEndedByUser(undone, false)

    sweep()

    expect(store.get(ended)?.error).toBe(store.ENDED_BY_USER_ERROR)
    expect(store.get(asking)?.error).toBe(store.ENDED_BY_USER_ERROR)
    expect(store.get(background)?.error).toBe(ORPHANED_AT_BOOT_ERROR)
    expect(store.get(undone)?.error).toBe(ORPHANED_AT_BOOT_ERROR)
    for (const id of [background, ended, asking, undone]) {
      expect(store.get(id)?.status).toBe('interrupted')
    }
    expect(store.get(ended)?.childSessionId).toBe('f2')
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
