import { isHibernatedSession } from '@/store/appStore'
import type { TerminalLeaseHost } from './terminal-lease'

// O que um Terminal faz quando a PTY sai. Hibernada não "encerrou": sem toast, e
// a aba (sem leaseHost) já virou a pane dormant no mesmo paneId — fechá-la a
// tiraria do layout. A janela de outro host (modal/dock/room) só fecha.
export type ExitAction = 'toast-and-close' | 'close' | 'keep'

export function exitAction(
  sessionId: string,
  leaseHost: TerminalLeaseHost | undefined,
): ExitAction {
  if (!isHibernatedSession(sessionId)) return 'toast-and-close'
  return leaseHost ? 'close' : 'keep'
}
