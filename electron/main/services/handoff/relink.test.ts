import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../migrations/index'

// Store REAL num SQLite migrado (o produtor do vínculo); só PTY e broadcast são
// do teste — o que se quer provar é que nada é relançado nem duplicado.
let testDb: Database.Database
vi.mock('../db', () => ({ getDb: () => testDb, handoffsInterruptedAtOpen: () => [] }))
// Linhas cujo exec recebeu o --settings de filha (accept-inbound).
const inbound = new Set<string>()
vi.mock('../session-settings', () => ({
  acceptsCrossSessionInbound: (id: string) => inbound.has(id),
}))
const transcripts = new Set<string>()
vi.mock('../transcript-path', () => ({
  findTranscriptPath: (cc: string) => (transcripts.has(cc) ? `/t/${cc}.jsonl` : null),
}))
const broadcasts: string[] = []
vi.mock('../notify', () => ({ broadcast: (ch: string) => broadcasts.push(ch) }))
const running = new Set<string>()
const kills: string[] = []
const exitListeners = new Set<(e: { sessionId: string }) => void>()
vi.mock('../pty-manager', () => ({
  ptyManager: {
    isRunning: (id: string) => running.has(id),
    kill: (id: string) => {
      kills.push(id)
      running.delete(id)
      for (const fn of [...exitListeners]) fn({ sessionId: id })
    },
    on: (_ev: string, fn: (e: { sessionId: string }) => void) => exitListeners.add(fn),
    off: (_ev: string, fn: (e: { sessionId: string }) => void) => exitListeners.delete(fn),
  },
}))
// O relance real (resumeHandoffChild) sobe PTY; aqui ele registra o que recebeu e
// faz o que o real faz no banco: linha nova da conversa, flags de filha, markRunning.
const resumes: Array<{ id: string; title: string | null }> = []
vi.mock('../../ipc/sessions', () => ({
  resumeHandoffChild: (id: string) => {
    const h = store.get(id)!
    const row = testDb
      .prepare('SELECT title, cc_session_id FROM sessions WHERE id = ?')
      .get(h.childSessionId) as { title: string | null; cc_session_id: string }
    resumes.push({ id, title: row.title })
    addSession('kid-relaunched', row.cc_session_id)
    inbound.add('kid-relaunched')
    running.add('kid-relaunched')
    return { handoff: store.markRunning(id, 'kid-relaunched'), alreadyRunning: false }
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

// spawn_args no formato que o startSession grava (o resume comum o COPIA da linha
// anterior, então ele não diz com que flags o processo vivo subiu).
function addSession(id: string, cc: string, spawn?: { handoffChild: boolean }): void {
  testDb
    .prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at, spawn_args)
       VALUES (?, 'r1', ?, 'running', ?, ?)`,
    )
    .run(id, cc, Date.now(), spawn ? JSON.stringify(spawn) : null)
}

function dispatch(mother: string, child: string, mode?: 'plan'): string {
  const h = store.create({
    motherSessionId: mother,
    targetRepoId: 'r1',
    task: 't',
    composedPrompt: 'p',
    ...(mode ? { mode } : {}),
  })
  store.markRunning(h.id, child)
  // O spawn de filha sobe com as flags de filha (apelido + accept-inbound).
  testDb
    .prepare('UPDATE sessions SET spawn_args = ? WHERE id = ?')
    .run(JSON.stringify({ handoffChild: true }), child)
  inbound.add(child)
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
    resumes.length = 0
    transcripts.clear()
    inbound.clear()
    exitListeners.clear()
    broadcasts.length = 0
  })

  afterEach(() => testDb.close())

  it('interrompida + dispensada e viva: re-vincula o mesmo handoff, sem kill', async () => {
    const id = dispatch('mae', 'kid')
    store.failIfRunning(id, 'caiu')
    store.dismiss(id)
    running.add('kid')
    expect(childLink('kid')).toMatchObject({ state: 'relinkable', relinkRestarts: false })

    const out = await relinkChild({ sessionId: 'kid', motherSessionId: 'mae-b' })

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

  it('linha retomada COMO FILHA por fora do relink (mesmo cc) re-vincula sem relançar', async () => {
    const id = dispatch('mae', 'kid')
    store.dismiss(id)
    addSession('kid-2', 'cc-kid', { handoffChild: true })
    inbound.add('kid-2')
    running.add('kid-2')

    expect((await relinkChild({ sessionId: 'kid-2' })).childSessionId).toBe('kid-2')
    expect(kills).toEqual([])
  })

  it('filha viva retomada como sessão COMUM: avisa e relança com o apelido de volta', async () => {
    const id = dispatch('mae', 'kid')
    testDb
      .prepare("UPDATE sessions SET title = 'api-1', title_source = 'manual' WHERE id = 'kid'")
      .run()
    store.dismiss(id)
    // Shape real do sessions:resume comum: spawn_args copiado (handoffChild: true)
    // mas o exec subiu sem o --settings de filha.
    addSession('kid-2', 'cc-kid', { handoffChild: true })
    testDb.prepare("UPDATE sessions SET title = 'Título do transcript' WHERE id = 'kid-2'").run()
    running.add('kid-2')
    transcripts.add('cc-kid')

    expect(childLink('kid-2')).toMatchObject({ state: 'relinkable', relinkRestarts: true })
    const out = await relinkChild({ sessionId: 'kid-2', motherSessionId: 'mae-b' })

    expect(kills).toEqual(['kid-2'])
    // O relance parte da linha comum já com o apelido que a mãe conhece.
    expect(resumes).toEqual([{ id, title: 'api-1' }])
    expect(out).toMatchObject({
      id,
      status: 'running',
      childSessionId: 'kid-relaunched',
      motherSessionId: 'mae-b',
      dismissedAt: null,
    })
    expect(store.list()).toHaveLength(1)
    expect(childLink('kid-relaunched')).toMatchObject({ state: 'active', relinkRestarts: false })
  })

  it('retomada como comum sem transcript: recusa antes de matar a sessão', async () => {
    const id = dispatch('mae', 'kid')
    store.dismiss(id)
    addSession('kid-2', 'cc-kid')
    running.add('kid-2')

    await expect(relinkChild({ sessionId: 'kid-2' })).rejects.toThrow(/histórico/)
    expect(kills).toEqual([])
    expect(store.get(id)?.childSessionId).toBe('kid')
  })

  it('sem vínculo: recusa e aponta pra adoção', async () => {
    expect(childLink('kid').state).toBe('none')
    await expect(relinkChild({ sessionId: 'kid' })).rejects.toThrow(/Tornar sessão filha/)
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

  it('desvincular solta TODOS os handoffs da conversa, inclusive o encerrado', () => {
    const old = dispatch('mae', 'kid')
    store.report(old, 'ok')
    // Encerrado ainda aponta pra filha: childLink devolve o handoff (a UI oferece
    // Desvincular) com estado 'none'.
    expect(childLink('kid')).toMatchObject({ state: 'none', handoff: { id: old } })
    addSession('kid-2', 'cc-kid')
    dispatch('mae-b', 'kid-2')

    detachChild({ sessionId: 'kid-2' })

    expect(childLink('kid-2').handoff).toBeNull()
    expect(childLink('kid').handoff).toBeNull()
  })

  it('recusa mãe descendente da filha (ciclo)', async () => {
    const id = dispatch('mae', 'kid')
    addSession('neta', 'cc-neta')
    // plan: só leitura, não disputa o diretório com a filha que escreve.
    dispatch('kid', 'neta', 'plan')
    expect(() => setChildMother({ handoffId: id, motherSessionId: 'neta' })).toThrow(/ciclo/)
    store.dismiss(id)
    await expect(relinkChild({ sessionId: 'kid', motherSessionId: 'neta' })).rejects.toThrow(
      /ciclo/,
    )
    expect(store.get(id)?.motherSessionId).toBe('mae')
  })
})
