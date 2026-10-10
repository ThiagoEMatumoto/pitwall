import { getDb } from './db'
import type { DormantPaneInfo } from '../../../shared/types/ipc'

// A pane dormindo não tem título no renderer (o snapshot não guarda). Sem ele a
// resolução por alias do agent-bus não a acha: completa pela linha mais recente
// de sessions com aquele cc_session_id (o startSession e o rename escrevem ali).
export function enrichDormantPanes(list: DormantPaneInfo[]): DormantPaneInfo[] {
  const stmt = getDb().prepare(
    `SELECT title, repo_id FROM sessions WHERE cc_session_id = ?
     ORDER BY started_at DESC LIMIT 1`,
  )
  return list.map((pane) => {
    if (pane.title !== null && pane.repoId !== null) return pane
    const row = stmt.get(pane.ccSessionId) as
      { title: string | null; repo_id: string | null } | undefined
    if (!row) return pane
    return { ...pane, title: pane.title ?? row.title, repoId: pane.repoId ?? row.repo_id }
  })
}
