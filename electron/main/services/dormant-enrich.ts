import { getDb } from './db'
import { findTranscriptPath } from './transcript-path'
import { readTranscriptTitle } from './session-activity'
import { sessionOwnTitle } from './session-graph'
import type { DormantPaneInfo } from '../../../shared/types/ipc'

// A pane dormindo não tem título no renderer (o snapshot não guarda). Sem ele a
// aba cai em "Avulsa" e a resolução por alias do agent-bus não a acha. O título
// segue o produtor da sessão viva: o name de uma sessão sem PID vivo é
// transcript (custom/ai-title) ?? sessions.title (ipc/sessions.ts, listLive), e o
// alias é sessionOwnTitle (rename manual > name > sessions.title). sessions.title
// sozinho é null para o claude resumido normalmente.
export function enrichDormantPanes(list: DormantPaneInfo[]): DormantPaneInfo[] {
  const stmt = getDb().prepare(
    `SELECT title, title_source, repo_id FROM sessions WHERE cc_session_id = ?
     ORDER BY started_at DESC LIMIT 1`,
  )
  return list.map((pane) => {
    if (pane.title !== null && pane.repoId !== null) return pane
    const row = stmt.get(pane.ccSessionId) as
      | { title: string | null; title_source: 'manual' | 'auto' | null; repo_id: string | null }
      | undefined
    const title =
      pane.title ??
      sessionOwnTitle({
        title: row?.title ?? null,
        titleSource: row?.title_source ?? null,
        liveName: transcriptTitle(pane.ccSessionId) ?? row?.title ?? null,
      })
    return { ...pane, title, repoId: pane.repoId ?? row?.repo_id ?? null }
  })
}

function transcriptTitle(ccSessionId: string): string | null {
  const transcript = findTranscriptPath(ccSessionId)
  return transcript ? readTranscriptTitle(transcript) : null
}
