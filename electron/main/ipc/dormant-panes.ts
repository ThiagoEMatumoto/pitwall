import { ipcMain } from 'electron'
import { z } from 'zod'
import { ptyManager } from '../services/pty-manager'
import { getMainWindow } from '../services/notifications'
import { DormantPanes, setDormantPanes } from '../services/dormant-panes'
import { foreignHolderPid } from '../services/conversation-holder'
import { computeRestorePlan } from '../services/restore-plan'
import { enrichDormantPanes } from '../services/dormant-enrich'
import { screenOf } from './send-prompt'
import type { RestorePlan } from '../../../shared/types/ipc'

// Lazy restore: o plano do boot (quem sobe eager), o espelho das panes dormindo
// e a volta do pedido de wake que o main fez ao renderer.

const restorePlanSchema = z.array(z.string().min(1)).max(500)
const dormantSyncSchema = z
  .array(
    z.object({
      ccSessionId: z.string().min(1),
      paneId: z.string().min(1),
      title: z.string().nullable(),
      repoId: z.string().nullable(),
    }),
  )
  .max(500)
const wakeResultSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  error: z.string().optional(),
})

let registered = false

export function registerDormantPanesIpc(): void {
  if (registered) return
  registered = true
  const panes = new DormantPanes({
    requestWake: (request) => {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) return false
      win.webContents.send('sessions:wake-request', request)
      return true
    },
    isRunning: (id) => ptyManager.isRunning(id),
    foreignHolderPid,
    screen: screenOf,
    warn: (event) => console.warn(JSON.stringify(event)),
  })
  setDormantPanes(panes)

  ipcMain.handle('sessions:restore-plan', (_e, raw: unknown): RestorePlan =>
    computeRestorePlan(restorePlanSchema.parse(raw)),
  )
  ipcMain.handle('sessions:dormant-sync', (_e, raw: unknown) => {
    panes.setDormant(enrichDormantPanes(dormantSyncSchema.parse(raw)))
  })
  ipcMain.handle('sessions:wake-result', (_e, raw: unknown) => {
    panes.onWakeResult(wakeResultSchema.parse(raw))
  })
}
