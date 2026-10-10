/** @vitest-environment node */
// Título/repo da pane dormindo completados pela tabela sessions de verdade (DB em
// tmp com as migrations do app): é o que a resolução por alias do agent-bus lê.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dormant-enrich-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { rmSync } from 'node:fs'
import { app } from 'electron'
import { closeDb, getDb } from './db'
import { enrichDormantPanes } from './dormant-enrich'

function session(id: string, cc: string, title: string | null, startedAt: number): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, title, status, started_at) VALUES (?, 'r1', ?, ?, 'exited', ?)`,
    )
    .run(id, cc, title, startedAt)
}

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM sessions').run()
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

describe('enrichDormantPanes', () => {
  it('preenche title e repoId nulos pela linha mais recente daquele cc', () => {
    session('old', 'cc-1', 'nome-antigo', 1)
    session('new', 'cc-1', 'infra-lazy', 2)

    const [pane] = enrichDormantPanes([
      { ccSessionId: 'cc-1', paneId: 'pane-1', title: null, repoId: null },
    ])

    expect(pane).toEqual({
      ccSessionId: 'cc-1',
      paneId: 'pane-1',
      title: 'infra-lazy',
      repoId: 'r1',
    })
  })

  it('não sobrescreve o que o renderer mandou', () => {
    session('s', 'cc-2', 'do-banco', 1)

    const [pane] = enrichDormantPanes([
      { ccSessionId: 'cc-2', paneId: 'p', title: 'da-pane', repoId: null },
    ])

    expect(pane.title).toBe('da-pane')
    expect(pane.repoId).toBe('r1')
  })

  it('cc sem linha em sessions fica como veio', () => {
    const input = { ccSessionId: 'cc-x', paneId: 'p', title: null, repoId: null }
    expect(enrichDormantPanes([input])).toEqual([input])
  })
})
