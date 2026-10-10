/** @vitest-environment node */
// Título/repo da pane dormindo pelo mesmo produtor da sessão viva: transcript em
// ~/.claude/projects (HOME em tmp) + tabela sessions de verdade (migrations do app).
// É o que a aba mostra e o que a resolução por alias do agent-bus lê.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const homeDir = vi.hoisted(() => ({ path: '' }))

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  const { mkdtempSync } = await import('node:fs')
  homeDir.path = mkdtempSync(os.tmpdir() + '/dormant-enrich-home-')
  return { ...os, homedir: () => homeDir.path }
})

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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { closeDb, getDb } from './db'
import { enrichDormantPanes } from './dormant-enrich'
import { DormantPanes } from './dormant-panes'

// Envelope real (redigido) do claude 2.1.286; as linhas de título têm o shape
// exato que o claude grava: {"type":"ai-title","aiTitle":…,"sessionId":…}.
const REAL_LINE = readFileSync(
  join(__dirname, '../../../shared/tui/__fixtures__/claude-2.1.286-send-message.jsonl'),
  'utf8',
).split('\n')[0]

function transcript(cc: string, titles: Array<{ ai?: string; custom?: string }>): void {
  const dir = join(homeDir.path, '.claude', 'projects', '-home-user-repo')
  mkdirSync(dir, { recursive: true })
  const lines = [
    REAL_LINE,
    ...titles.map((t) =>
      t.custom
        ? JSON.stringify({ type: 'custom-title', customTitle: t.custom, sessionId: cc })
        : JSON.stringify({ type: 'ai-title', aiTitle: t.ai, sessionId: cc }),
    ),
  ]
  writeFileSync(join(dir, `${cc}.jsonl`), lines.join('\n') + '\n')
}

function sessionRow(
  id: string,
  cc: string,
  title: string | null,
  startedAt: number,
  titleSource: 'manual' | 'auto' | null = null,
): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, repo_id, cc_session_id, title, title_source, status, started_at)
       VALUES (?, 'r1', ?, ?, ?, 'exited', ?)`,
    )
    .run(id, cc, title, titleSource, startedAt)
}

const session = (id: string, cc: string, title: string | null, startedAt: number) =>
  sessionRow(id, cc, title, startedAt)

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM sessions').run()
  rmSync(join(homeDir.path, '.claude'), { recursive: true, force: true })
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
  rmSync(homeDir.path, { recursive: true, force: true })
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

  it('pane do snapshot (repoId presente, title null) recebe o título do DB', () => {
    session('s', 'cc-3', 'lazy-C', 1)

    const [pane] = enrichDormantPanes([
      { ccSessionId: 'cc-3', paneId: 'p', title: null, repoId: 'r1' },
    ])

    expect(pane).toEqual({ ccSessionId: 'cc-3', paneId: 'p', title: 'lazy-C', repoId: 'r1' })
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

  it('claude resumido sem sessions.title: título do transcript (custom-title > ai-title)', () => {
    sessionRow('s', 'cc-t', null, 1)
    transcript('cc-t', [{ ai: 'Gerado pelo CC' }, { custom: 'lazy-A' }, { ai: 'Outro gerado' }])

    const [pane] = enrichDormantPanes([
      { ccSessionId: 'cc-t', paneId: 'p', title: null, repoId: 'r1' },
    ])

    expect(pane.title).toBe('lazy-A')
  })

  it('só ai-title: usa o título gerado, como a sessão viva', () => {
    sessionRow('s', 'cc-ai', null, 1)
    transcript('cc-ai', [{ ai: 'Investigar restore' }])

    const [pane] = enrichDormantPanes([
      { ccSessionId: 'cc-ai', paneId: 'p', title: null, repoId: 'r1' },
    ])

    expect(pane.title).toBe('Investigar restore')
  })

  it('rename manual vence o transcript; título auto perde para ele', () => {
    sessionRow('m', 'cc-m', 'meu-nome', 1, 'manual')
    transcript('cc-m', [{ custom: 'do-transcript' }])
    sessionRow('a', 'cc-a', 'salvo-auto', 1, 'auto')
    transcript('cc-a', [{ custom: 'do-transcript' }])

    const [m, a] = enrichDormantPanes([
      { ccSessionId: 'cc-m', paneId: 'pm', title: null, repoId: 'r1' },
      { ccSessionId: 'cc-a', paneId: 'pa', title: null, repoId: 'r1' },
    ])

    expect(m.title).toBe('meu-nome')
    expect(a.title).toBe('do-transcript')
  })

  it('findDormantByAlias acha a pane pelo título vindo do transcript', () => {
    sessionRow('s', 'cc-t', null, 1)
    transcript('cc-t', [{ custom: 'lazy-A' }])
    const panes = new DormantPanes({
      requestWake: () => false,
      isRunning: () => false,
      screen: async () => null,
      warn: () => {},
    })

    panes.setDormant(
      enrichDormantPanes([{ ccSessionId: 'cc-t', paneId: 'p', title: null, repoId: 'r1' }]),
    )

    expect(panes.findDormantByAlias('Lazy-A').map((p) => p.ccSessionId)).toEqual(['cc-t'])
  })
})
