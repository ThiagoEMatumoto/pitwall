import { ipcMain } from 'electron'
import { getDb } from '../services/db'
import type { PaneSnapshot, WorkspaceBootState } from '../../../shared/types/ipc'

interface ActiveRow {
  active_project_id: string | null
}

interface BootRow {
  open_panes: string | null
  clean_shutdown: number
  restore_attempts: number
  dock_layout: string | null
}

// O valor de clean_shutdown do boot ANTERIOR precisa ser lido antes de o boot
// atual o sobrescrever com 0. markRunning() captura esse valor em memória e só
// então zera no banco, para que getBootState (chamado pelo renderer já com o app
// rodando) ainda enxergue o estado real do shutdown passado.
let prevCleanShutdown = false

function ensureRow(): void {
  getDb()
    .prepare(
      `INSERT INTO workspace_state (id, last_opened_at) VALUES (1, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(Date.now())
}

export function markWorkspaceRunning(): void {
  ensureRow()
  const row = getDb()
    .prepare('SELECT clean_shutdown FROM workspace_state WHERE id = 1')
    .get() as Pick<BootRow, 'clean_shutdown'> | undefined
  prevCleanShutdown = row?.clean_shutdown === 1
  getDb().prepare('UPDATE workspace_state SET clean_shutdown = 0 WHERE id = 1').run()
}

// O boot anterior terminou por quit normal? Só vale depois de markWorkspaceRunning.
export function previousShutdownWasClean(): boolean {
  return prevCleanShutdown
}

export function markWorkspaceCleanShutdown(): void {
  getDb().prepare('UPDATE workspace_state SET clean_shutdown = 1 WHERE id = 1').run()
}

export function registerWorkspaceIpc(): void {
  ipcMain.handle('workspace:get-active', () => {
    const row = getDb()
      .prepare('SELECT active_project_id FROM workspace_state WHERE id = 1')
      .get() as ActiveRow | undefined
    return row?.active_project_id ?? null
  })

  ipcMain.handle('workspace:set-active', (_e, { projectId }: { projectId: string | null }) => {
    getDb()
      .prepare(
        `INSERT INTO workspace_state (id, active_project_id, last_opened_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET active_project_id = excluded.active_project_id`,
      )
      .run(projectId, Date.now())
  })

  ipcMain.handle('workspace:save-panes', (_e, { panes }: { panes: PaneSnapshot[] }) => {
    ensureRow()
    getDb()
      .prepare('UPDATE workspace_state SET open_panes = ? WHERE id = 1')
      .run(JSON.stringify(panes))
  })

  ipcMain.handle('workspace:save-layout', (_e, { layout }: { layout: string | null }) => {
    ensureRow()
    getDb().prepare('UPDATE workspace_state SET dock_layout = ? WHERE id = 1').run(layout)
  })

  ipcMain.handle('workspace:get-boot-state', (): WorkspaceBootState => {
    const row = getDb()
      .prepare('SELECT open_panes, restore_attempts, dock_layout FROM workspace_state WHERE id = 1')
      .get() as Pick<BootRow, 'open_panes' | 'restore_attempts' | 'dock_layout'> | undefined
    let openPanes: PaneSnapshot[] = []
    if (row?.open_panes) {
      try {
        openPanes = JSON.parse(row.open_panes) as PaneSnapshot[]
      } catch {
        openPanes = []
      }
    }
    return {
      openPanes,
      cleanShutdown: prevCleanShutdown,
      restoreAttempts: row?.restore_attempts ?? 0,
      dockLayout: row?.dock_layout ?? null,
    }
  })

  ipcMain.handle('workspace:bump-restore-attempts', () => {
    getDb()
      .prepare('UPDATE workspace_state SET restore_attempts = restore_attempts + 1 WHERE id = 1')
      .run()
  })

  ipcMain.handle('workspace:reset-restore-attempts', () => {
    getDb().prepare('UPDATE workspace_state SET restore_attempts = 0 WHERE id = 1').run()
  })
}
