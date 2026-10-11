/** @vitest-environment node */
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readOpenPanes } from './workspace-state'
import { runAndKill } from './test-support/kill-after-write'

// Durabilidade do open_panes contra kill -9 com processo de verdade: o filho
// grava pelo mesmo serviço do IPC e leva SIGKILL assim que avisa que gravou.

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-panes-kill-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('o open_panes gravado sobrevive a SIGKILL logo depois do save', async () => {
  const dbPath = join(dir, 'app.db')
  const panes = [
    {
      ccSessionId: 'cc-1',
      repo: null,
      projectName: null,
      projectIcon: null,
      projectColor: null,
      paneId: 'pane-1',
    },
    {
      ccSessionId: 'cc-2',
      repo: null,
      projectName: 'P',
      projectIcon: null,
      projectColor: null,
      paneId: 'pane-recem-aberta',
    },
  ]
  const exit = await runAndKill({
    entry: 'workspace-panes-writer.ts',
    dir,
    args: [dbPath, JSON.stringify(panes)],
    marker: 'saved',
  })
  expect(exit.signal).toBe('SIGKILL')

  const db = new Database(dbPath)
  try {
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(readOpenPanes(db)).toEqual(panes)
  } finally {
    db.close()
  }
}, 20000)
