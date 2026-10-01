// LiveSessionInfo de uma sessão SEM id nativo (Codex): nada de transcript nem
// índice de PIDs — status pela PTY (ptyStatusFor) e nome pelo título da linha.
// O campo ccSessionId carrega o sessions.id: é a chave com que o batch global
// (session-activity) atualiza a mesma entrada no renderer.
import { ptyManager } from '../services/pty-manager'
import { ptyStatusFor } from '../services/session-activity'
import { mapLiveSessionRepo, type LiveSessionJoinRow } from './live-session-mapping'
import type { AgentProviderId, LiveSessionInfo } from '../../../shared/types/ipc'

type PtyOnlyRow = Omit<LiveSessionJoinRow, 'cc_session_id'> & {
  provider: AgentProviderId | null
}

export function livePtySessionInfo(sessionId: string, row: PtyOnlyRow): LiveSessionInfo {
  const { repo, projectName, projectIcon, projectColor } = mapLiveSessionRepo({
    ...row,
    cc_session_id: sessionId,
  })
  return {
    id: sessionId,
    ccSessionId: sessionId,
    name: row.session_title,
    title: row.session_title_source === 'manual' ? row.session_title : null,
    status: ptyStatusFor(sessionId),
    repo,
    projectName,
    projectIcon,
    projectColor,
    lastActivityAt: ptyManager.getActivitySample(sessionId)?.lastByteAt ?? null,
    lastText: null,
    isResumable: false,
    titleSource: row.session_title_source,
    cwd: null,
    provider: row.provider ?? 'claude',
  }
}
