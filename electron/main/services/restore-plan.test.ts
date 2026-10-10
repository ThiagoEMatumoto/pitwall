/** @vitest-environment node */
// Plano do lazy restore contra o produtor real: DB better-sqlite3 em tmp com as
// migrations do app, handoffs criados e transicionados pelo handoff-store e a pref
// gravada pelo prefs-store (o mesmo que o prefs:set usa).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'restore-plan-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { rmSync } from 'node:fs'
import { app } from 'electron'
import { closeDb, getDb } from './db'
import * as handoffStore from './handoff-store'
import { setPref } from './prefs-store'
import { LAZY_RESTORE_PREF, computeRestorePlan } from './restore-plan'

function session(id: string, cc: string): void {
  // Mesmas colunas que o startSession grava (sessions.ts) — é o escritor real.
  getDb()
    .prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, title, status, started_at) VALUES (?, 'r1', ?, ?, 'running', ?)`,
    )
    .run(id, cc, id, Date.now())
}

function activeHandoff(mother: string, child: string): string {
  const h = handoffStore.create({
    targetRepoId: 'r1',
    task: 't',
    composedPrompt: 'p',
    motherSessionId: mother,
    featureId: null,
  })
  handoffStore.approve(h.id, {})
  handoffStore.markRunning(h.id, child)
  return h.id
}

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM handoff_events').run()
  db.prepare('DELETE FROM handoffs').run()
  db.prepare('DELETE FROM sessions').run()
  db.prepare('DELETE FROM app_prefs WHERE key = ?').run(LAZY_RESTORE_PREF)
  setPref(LAZY_RESTORE_PREF, true)
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',1,1)`,
  ).run()
  db.prepare(
    `INSERT OR IGNORE INTO repos (id, project_id, label, path, position, created_at) VALUES ('r1','p1','r1','/tmp/r1',0,1)`,
  ).run()
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('computeRestorePlan', () => {
  it('mãe e filha de handoff ativo sobem eager; sessão sem handoff dorme', () => {
    session('mother', 'cc-mother')
    session('child', 'cc-child')
    session('loose', 'cc-loose')
    activeHandoff('mother', 'child')

    const plan = computeRestorePlan(['cc-mother', 'cc-child', 'cc-loose'])

    expect(plan.mode).toBe('lazy')
    expect([...plan.eagerCcSessionIds].sort()).toEqual(['cc-child', 'cc-mother'])
  })

  it('needs_input ainda é ativo', () => {
    session('mother', 'cc-mother')
    session('child', 'cc-child')
    const id = activeHandoff('mother', 'child')
    handoffStore.ask(id, 'posso?')
    expect(handoffStore.get(id)?.status).toBe('needs_input')

    expect(computeRestorePlan(['cc-mother', 'cc-child']).eagerCcSessionIds.sort()).toEqual([
      'cc-child',
      'cc-mother',
    ])
  })

  it('handoff terminal não conta', () => {
    session('mother', 'cc-mother')
    session('child', 'cc-child')
    const id = activeHandoff('mother', 'child')
    handoffStore.report(id, 'pronto')
    expect(handoffStore.get(id)?.status).toBe('done')

    expect(computeRestorePlan(['cc-mother', 'cc-child']).eagerCcSessionIds).toEqual([])
  })

  it('só devolve cc pedidos: handoff ativo de conversa sem pane não entra', () => {
    session('mother', 'cc-mother')
    session('child', 'cc-child')
    activeHandoff('mother', 'child')

    expect(computeRestorePlan(['cc-mother']).eagerCcSessionIds).toEqual(['cc-mother'])
  })

  // O boot de verdade: o getDb da abertura marca running/needs_input como
  // 'interrupted' ANTES de o renderer pedir o plano.
  it('handoff em voo quando o app fechou: mãe e filha sobem eager depois do sweep do getDb', () => {
    session('mother', 'cc-mother')
    session('child', 'cc-child')
    session('loose', 'cc-loose')
    const id = activeHandoff('mother', 'child')
    closeDb()
    getDb()
    expect(handoffStore.get(id)?.status).toBe('interrupted')

    const plan = computeRestorePlan(['cc-mother', 'cc-child', 'cc-loose'])

    expect([...plan.eagerCcSessionIds].sort()).toEqual(['cc-child', 'cc-mother'])
  })

  it("'interrupted' de antes desta abertura do banco não sobe eager", () => {
    session('mother', 'cc-mother')
    session('child', 'cc-child')
    const id = activeHandoff('mother', 'child')
    closeDb()
    getDb()
    // Segundo boot sem retomar nada: o handoff já era 'interrupted' ao abrir.
    closeDb()
    getDb()
    expect(handoffStore.get(id)?.status).toBe('interrupted')

    expect(computeRestorePlan(['cc-mother', 'cc-child']).eagerCcSessionIds).toEqual([])
  })

  it('pref sessions.lazyRestore ausente (default) sobe todas, mesmo com handoff ativo', () => {
    getDb().prepare('DELETE FROM app_prefs WHERE key = ?').run(LAZY_RESTORE_PREF)
    session('mother', 'cc-mother')
    session('child', 'cc-child')
    session('loose', 'cc-loose')
    activeHandoff('mother', 'child')

    const plan = computeRestorePlan(['cc-mother', 'cc-child', 'cc-loose'])

    expect(plan).toEqual({
      mode: 'eager',
      eagerCcSessionIds: ['cc-mother', 'cc-child', 'cc-loose'],
    })
  })

  it('pref sessions.lazyRestore = false sobe todas', () => {
    session('loose', 'cc-loose')
    session('other', 'cc-other')
    setPref(LAZY_RESTORE_PREF, false)

    const plan = computeRestorePlan(['cc-loose', 'cc-other'])

    expect(plan).toEqual({ mode: 'eager', eagerCcSessionIds: ['cc-loose', 'cc-other'] })
  })

  it("valor legado da pref ('lazy' do restoreMode antigo) não liga", () => {
    session('loose', 'cc-loose')
    setPref(LAZY_RESTORE_PREF, 'lazy')

    expect(computeRestorePlan(['cc-loose']).mode).toBe('eager')
  })
})
