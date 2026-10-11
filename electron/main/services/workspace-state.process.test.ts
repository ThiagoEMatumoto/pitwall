/** @vitest-environment node */
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openAppDb } from './db'
import { readDockLayout, readOpenPanes, saveDockLayout, saveOpenPanes } from './workspace-state'
import { layoutRestoreStep, layoutToRestore } from '../../../shared/dock-layout-restore'
import type { PaneSnapshot } from '../../../shared/types/ipc'
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

// open_panes e dock_layout gravam em transações separadas. Em qualquer ponto em
// que o kill caia, o boot tem que mostrar as abas do open_panes: o layout só vale
// com paneId em comum, senão o grid padrão; e o restore nunca fica esperando.
const snap = (id: string): PaneSnapshot => ({
  ccSessionId: `cc-${id}`,
  repo: null,
  projectName: null,
  projectIcon: null,
  projectColor: null,
  paneId: id,
})
// Forma do api.toJSON() do dockview: o que importa ao restore é a chave de panels.
const dockJson = (ids: string[]) =>
  JSON.stringify({
    grid: {
      root: {
        type: 'branch',
        data: [{ type: 'leaf', data: { views: ids, activeView: ids[0], id: 'g1' }, size: 800 }],
        size: 600,
      },
      width: 800,
      height: 600,
      orientation: 'HORIZONTAL',
    },
    panels: Object.fromEntries(ids.map((id) => [id, { id, contentComponent: 'terminal' }])),
    activeGroup: 'g1',
  })

describe.each([
  // Fecha A e abre B: o caso do review (layout {A} com open_panes [B]).
  { name: 'troca A→B', before: ['A'], after: ['B'] },
  // Abre B mantendo A.
  { name: 'abre B', before: ['A'], after: ['A', 'B'] },
])('kill -9 entre o open_panes e o dock_layout ($name)', ({ before, after }) => {
  it.each([
    { written: 'só open_panes', panes: true, layout: false },
    { written: 'só dock_layout', panes: false, layout: true },
    { written: 'os dois', panes: true, layout: true },
  ])(
    '$written: as abas do open_panes aparecem',
    async ({ panes, layout }) => {
      const dbPath = join(dir, 'app.db')
      const seed = openAppDb(dbPath)
      saveOpenPanes(seed, before.map(snap))
      saveDockLayout(seed, dockJson(before))
      seed.close()

      const exit = await runAndKill({
        entry: 'workspace-panes-writer.ts',
        dir,
        args: [
          dbPath,
          panes ? JSON.stringify(after.map(snap)) : '-',
          layout ? dockJson(after) : '-',
        ],
        marker: 'saved',
      })
      expect(exit.signal).toBe('SIGKILL')

      const db = new Database(dbPath)
      let openPanes: PaneSnapshot[]
      let dockLayout: string | null
      try {
        openPanes = readOpenPanes(db)
        dockLayout = readDockLayout(db)
      } finally {
        db.close()
      }
      expect(openPanes.map((p) => p.paneId)).toEqual(panes ? after : before)

      const pending = layoutToRestore(dockLayout, openPanes)
      const tabs = new Set(openPanes.map((p) => p.paneId as string))
      expect(tabs.size).toBeGreaterThan(0)
      if (pending) {
        // O layout que sobra fala de pelo menos uma aba salva: aplica, e a
        // reconciliação acrescenta as outras. Restore terminado: nunca 'wait' (as que
        // não voltam saem no fallback do parcial).
        const wanted = Object.keys(JSON.parse(pending).panels as object)
        expect(wanted.some((id) => tabs.has(id))).toBe(true)
        expect(layoutRestoreStep(wanted, tabs, true)).not.toBe('wait')
      }
    },
    20000,
  )
})
