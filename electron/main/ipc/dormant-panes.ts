import { ipcMain } from 'electron'
import { z } from 'zod'
import { ptyManager } from '../services/pty-manager'
import { getMainWindow } from '../services/notifications'
import {
  DormantPanes,
  getDormantPanes,
  setDormantPanes,
  waitPtyReady,
} from '../services/dormant-panes'
import { redeliverFailedWakes } from '../services/handoff/handoff-wake'
import { setResumedSessionHook } from './sessions'
import { foreignHolderPid } from '../services/conversation-holder'
import { computeRestorePlan, lazyRestoreEnabled } from '../services/restore-plan'
import { enrichDormantPanes } from '../services/dormant-enrich'
import { screenOf } from './send-prompt'
import type {
  DormantBecameLiveEvent,
  DormantPaneInfo,
  RestorePlan,
  Session,
} from '../../../shared/types/ipc'

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
  setDormantPanes(panes, lazyRestoreEnabled)
  // A mãe que dormia voltou (wake ou resume dela): os wake_failed dela saem de novo
  // assim que a TUI estiver pronta para a fila on-idle.
  setResumedSessionHook((session, origin) => {
    if (origin === 'main') announceDormantBecameLive(session)
    const sessionId = session.id
    void waitPtyReady(sessionId, { isRunning: (id) => ptyManager.isRunning(id), screen: screenOf })
      .then((ready) => (ready === 'ready' ? redeliverFailedWakes(sessionId) : 0))
      .catch((err) => console.error('[dormant-panes] reenvio de wake_failed falhou:', err))
  })

  ipcMain.handle('sessions:restore-plan', (_e, raw: unknown): RestorePlan =>
    computeRestorePlan(restorePlanSchema.parse(raw)),
  )
  // Devolve a lista enriquecida: o renderer aplica o título nas panes dormindo
  // (o snapshot não o guarda e sem ele a aba cai no rótulo do repo).
  ipcMain.handle('sessions:dormant-sync', (_e, raw: unknown): DormantPaneInfo[] => {
    const list = dormantSyncSchema.parse(raw)
    // Pref desligada: o registro fica vazio, nada no main acorda pane.
    if (!lazyRestoreEnabled()) {
      panes.setDormant([])
      return list
    }
    const enriched = enrichDormantPanes(list)
    panes.setDormant(enriched)
    return enriched
  })
  ipcMain.handle('sessions:wake-result', (_e, raw: unknown) => {
    panes.onWakeResult(wakeResultSchema.parse(raw))
  })
}

// O main retomou (handoffs:resume, adopt) uma conversa que o renderer mostra
// dormindo: sem o aviso a pane seguiria dormindo e um clique nela pediria um
// segundo resume (que a guarda do main transformaria em re-attach). O renderer
// troca a pane pela sessão viva. Com a pref desligada não há pane dormindo.
function announceDormantBecameLive(session: Session): void {
  const panes = getDormantPanes()
  const cc = session.ccSessionId
  if (!panes || !cc || !panes.findDormantByCc(cc)) return
  panes.forget(cc)
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  const event: DormantBecameLiveEvent = { ccSessionId: cc, session }
  win.webContents.send('sessions:dormant-became-live', event)
}
