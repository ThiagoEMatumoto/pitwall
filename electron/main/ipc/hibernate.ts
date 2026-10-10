import { ipcMain } from 'electron'
import { ptyManager } from '../services/pty-manager'
import { getPref } from '../services/prefs-store'
import { activeHandoffCcSessionIds } from '../services/handoff-store'
import { findTranscriptPath } from '../services/transcript-path'
import { isSessionPidAlive } from '../services/session-activity'
import { getDormantPanes } from '../services/dormant-panes'
import { lazyRestoreEnabled } from '../services/restore-plan'
import { inspectProcTree } from '../services/hibernate/proc-tree'
import { ScheduleScanner } from '../services/hibernate/schedule-scan'
import {
  IdleHibernator,
  getIdleHibernator,
  setIdleHibernator,
} from '../services/hibernate/idle-hibernator'
import {
  agentMessageSince,
  claudeCandidates,
  hasAwakePane,
  sessionFileFor,
} from '../services/hibernate/hibernate-sources'
import { promptQueue } from './send-prompt'
import { findAliveByCc } from './sessions'
import { lazyRestoreAtBoot } from './dormant-panes'
import {
  HIBERNATE_AFTER_MIN_PREF,
  sanitizeHibernateAfterMin,
  type HibernateDisabledReason,
  type HibernateStatsView,
} from '../../../shared/hibernate'

// Ligação da hibernação no main: o tick só existe com o lazyRestore do boot, a
// pref ao vivo do lazyRestore e hibernateAfterMin > 0. O prefs:set das duas prefs
// chama reschedule (ipc/prefs); o exit da PTY emite sessions:hibernated antes do
// pty:exit (ipc/sessions).

function afterMinPref(): number {
  return sanitizeHibernateAfterMin(getPref<unknown>(HIBERNATE_AFTER_MIN_PREF, 0))
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

export function createIdleHibernator(): IdleHibernator {
  const scanner = new ScheduleScanner()
  return new IdleHibernator({
    lazyRestore: () => lazyRestoreAtBoot() && lazyRestoreEnabled(),
    afterMin: afterMinPref,
    candidates: () => claudeCandidates(ptyManager.runningIds()),
    hasPane: (cc) => hasAwakePane(cc, (c) => getDormantPanes()?.findDormantByCc(c) != null),
    lastIoAt: (id) => ptyManager.getLastIoAt(id),
    sessionFile: sessionFileFor,
    isPidAlive: (file) => isSessionPidAlive(file),
    aliveSessionId: (cc) => findAliveByCc(cc)?.id ?? null,
    activeHandoffCcSessionIds,
    queueHas: (id) => promptQueue.snapshot().items.some((item) => item.sessionId === id),
    agentMessageSince,
    transcriptPath: findTranscriptPath,
    usedScheduling: (path) => scanner.usedScheduling(path),
    procTree: (pid) => inspectProcTree(pid),
    send: (input) => promptQueue.send(input),
    cancel: (id) => {
      promptQueue.cancel(id)
    },
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
}
