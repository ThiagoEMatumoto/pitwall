import { ipcMain } from 'electron'
import { z } from 'zod'
import { ptyManager } from '../services/pty-manager'
import { getDb } from '../services/db'
import { getPref } from '../services/prefs-store'
import { activeHandoffCcSessionIds, childHandoffKindCc } from '../services/handoff-store'
import { findTranscriptPath } from '../services/transcript-path'
import { isSessionPidAlive } from '../services/session-activity'
import { getDormantPanes } from '../services/dormant-panes'
import { enrichDormantPanes } from '../services/dormant-enrich'
import { getMainWindow } from '../services/notifications'
import { PaneConfirmer } from '../services/hibernate/pane-confirm'
import { lazyRestoreEnabled } from '../services/restore-plan'
import { inspectProcTree } from '../services/hibernate/proc-tree'
import { ScheduleScanner } from '../services/hibernate/schedule-scan'
import { markHibernated, unmarkHibernated } from '../services/hibernate/hibernated-store'
import {
  IdleHibernator,
  getIdleHibernator,
  setIdleHibernator,
} from '../services/hibernate/idle-hibernator'
import {
  claudeCandidates,
  hasAwakePane,
  sessionFileFor,
} from '../services/hibernate/hibernate-sources'
import { promptQueue } from './send-prompt'
import { findAliveByCc } from './sessions'
import { lazyRestoreAtBoot } from './dormant-panes'
import {
  CHILD_HIBERNATE_AFTER_MIN_PREF,
  DEFAULT_CHILD_HIBERNATE_AFTER_MIN,
  HIBERNATE_AFTER_MIN_PREF,
  sanitizeHibernateAfterMin,
  type HibernateDisabledReason,
  type HibernateStatsView,
} from '../../../shared/hibernate'

// Ligação da hibernação no main. A geral só existe com o lazyRestore do boot, a
// pref ao vivo do lazyRestore e hibernateAfterMin > 0; a da filha de handoff
// concluído só depende da janela dela. O tick roda com qualquer uma das duas. O
// prefs:set das três prefs chama reschedule (ipc/prefs); o exit da PTY emite
// sessions:hibernated antes do pty:exit (ipc/sessions).

function afterMinPref(): number {
  return sanitizeHibernateAfterMin(getPref<unknown>(HIBERNATE_AFTER_MIN_PREF, 0))
}

// Sem a pref gravada vale o padrão; 0 gravado desliga.
function childAfterMinPref(): number {
  return sanitizeHibernateAfterMin(
    getPref<unknown>(CHILD_HIBERNATE_AFTER_MIN_PREF, DEFAULT_CHILD_HIBERNATE_AFTER_MIN),
  )
}

export function hibernateDisabledReason(): HibernateDisabledReason | undefined {
  if (!lazyRestoreAtBoot()) return 'lazy-restore-off-at-boot'
  if (!lazyRestoreEnabled()) return 'lazy-restore-off'
  if (afterMinPref() <= 0) return 'after-min-off'
  return undefined
}

export function hibernateStatsView(): HibernateStatsView {
  const stats = getIdleHibernator()?.getStats()
  const reasonDisabled = hibernateDisabledReason()
  return {
    hibernated: stats?.hibernated ?? 0,
    refusals: { ...(stats?.refused ?? {}) },
    enabled: reasonDisabled === undefined,
    ...(reasonDisabled ? { reasonDisabled } : {}),
  }
}

const paneCheckResultSchema = z.object({
  requestId: z.string().min(1),
  paneId: z.string().min(1).nullable(),
  focused: z.boolean(),
  composerHasText: z.boolean(),
  composerFocused: z.boolean(),
})

const paneConfirmer = new PaneConfirmer({
  request: (request) => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return false
    win.webContents.send('sessions:pane-check-request', request)
    return true
  },
})

// A dormant entra no registro do main no exit, antes do dormantSync do renderer.
function registerHibernatedDormant(ccSessionId: string, paneId: string): void {
  const panes = getDormantPanes()
  if (!panes) return
  const [info] = enrichDormantPanes([{ ccSessionId, paneId, title: null, repoId: null }])
  panes.add(info)
}

export function createIdleHibernator(): IdleHibernator {
  const scanner = new ScheduleScanner()
  return new IdleHibernator({
    lazyRestore: () => lazyRestoreAtBoot() && lazyRestoreEnabled(),
    afterMin: afterMinPref,
    childAfterMin: childAfterMinPref,
    candidates: () => claudeCandidates(ptyManager.runningIds()),
    hasPane: (cc) => hasAwakePane(cc, (c) => getDormantPanes()?.findDormantByCc(c) != null),
    confirmPane: (sessionId, cc) => paneConfirmer.confirm(sessionId, cc),
    registerDormant: registerHibernatedDormant,
    persistHibernating: (sessionId, on) =>
      on ? markHibernated(getDb(), sessionId) : unmarkHibernated(getDb(), sessionId),
    lastIoAt: (id) => ptyManager.getLastIoAt(id),
    sessionFile: sessionFileFor,
    isPidAlive: (file) => isSessionPidAlive(file),
    aliveSessionId: (cc) => findAliveByCc(cc)?.id ?? null,
    activeHandoffCcSessionIds,
    handoffChildKind: childHandoffKindCc,
    queueHas: (id) => promptQueue.snapshot().items.some((item) => item.sessionId === id),
    transcriptPath: findTranscriptPath,
    scanTranscript: (path) => scanner.scan(path),
    procTree: (pid) => inspectProcTree(pid),
    send: (input) => promptQueue.send(input),
    cancel: (id) => {
      promptQueue.cancel(id)
    },
    replaceText: (id, text) => promptQueue.replaceText(id, text),
    warn: (event) => console.warn(JSON.stringify(event)),
  })
}

let registered = false

export function __resetHibernateForTests(): void {
  getIdleHibernator()?.dispose()
  setIdleHibernator(null)
  registered = false
}

// Depois de registerDormantPanesIpc: o valor do boot do lazyRestore é congelado lá.
export function registerHibernateIpc(): void {
  if (registered) return
  registered = true
  const hibernator = createIdleHibernator()
  setIdleHibernator(hibernator)
  hibernator.reschedule()
  ipcMain.handle('sessions:hibernate-stats', (): HibernateStatsView => hibernateStatsView())
  ipcMain.handle('sessions:pane-check-result', (_e, raw: unknown) => {
    paneConfirmer.onResult(paneCheckResultSchema.parse(raw))
  })
  ipcMain.handle('sessions:pane-closed', (_e, raw: unknown) => {
    getIdleHibernator()?.onPaneClosed(z.string().min(1).parse(raw))
  })
}
