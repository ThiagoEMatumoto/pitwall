// Leitores que alimentam o gate da hibernação, cada um da fonte que já responde
// a pergunta no app (escritor real entre parênteses):
// - status do claude: buildSessionsFileIndex (o próprio claude, sessions/<pid>.json);
// - pane aberta: workspace_state.open_panes (renderer, via workspace:save-panes);
// - agent_ask: agent_messages (agent-bus).
import { getDb } from '../db'
import { buildSessionsFileIndex } from '../session-activity'
import type { PaneSnapshot } from '../../../../shared/types/ipc'
import type { HibernateCandidate, SessionFileState } from './idle-hibernator'

export function sessionFileFor(ccSessionId: string): SessionFileState | null {
  const entry = buildSessionsFileIndex().get(ccSessionId)
  if (!entry) return null
  return { pid: entry.pid, status: entry.status ?? null, statusUpdatedAt: entry.statusUpdatedAt }
}

// Aba no layout salvo E acordada (a dormant não tem PTY, mas o snapshot é igual).
export function hasAwakePane(ccSessionId: string, isDormant: (cc: string) => boolean): boolean {
  const row = getDb().prepare('SELECT open_panes FROM workspace_state WHERE id = 1').get() as
    { open_panes: string | null } | undefined
  if (!row?.open_panes) return false
  let panes: PaneSnapshot[]
  try {
    panes = JSON.parse(row.open_panes) as PaneSnapshot[]
  } catch {
    return false
  }
  if (!Array.isArray(panes)) return false
  return panes.some((p) => p?.ccSessionId === ccSessionId) && !isDormant(ccSessionId)
}

// Qualquer sessions.id da mesma conversa conta (o --resume troca o sessions.id e
// mantém o cc). Pendente = alguém ainda espera resposta, independe da janela.
export function agentMessageSince(ccSessionId: string, since: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM agent_messages
        WHERE (from_session_id IN (SELECT id FROM sessions WHERE cc_session_id = ?)
               OR to_session_id IN (SELECT id FROM sessions WHERE cc_session_id = ?))
          AND (status = 'pending'
               OR MAX(created_at, COALESCE(delivered_at, 0), COALESCE(answered_at, 0)) >= ?)
        LIMIT 1`,
    )
    .get(ccSessionId, ccSessionId, since)
  return row !== undefined
}

// PTYs vivas do provider claude com conversa nativa.
export function claudeCandidates(runningIds: string[]): HibernateCandidate[] {
  if (runningIds.length === 0) return []
  const rows = getDb()
    .prepare(
      `SELECT id, cc_session_id FROM sessions
        WHERE id IN (${runningIds.map(() => '?').join(',')})
          AND cc_session_id IS NOT NULL
          AND COALESCE(provider, 'claude') = 'claude'`,
    )
    .all(...runningIds) as Array<{ id: string; cc_session_id: string }>
  return rows.map((r) => ({ sessionId: r.id, ccSessionId: r.cc_session_id }))
}
