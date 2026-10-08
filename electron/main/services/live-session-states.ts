import { getDb } from './db'
import { ptyManager } from './pty-manager'
import { buildSessionsFileIndex, isPidAlive, mapStatus, ptyStatusFor } from './session-activity'
import type { LiveSessionState } from './session-graph'

export type SessionsFileIndex = ReturnType<typeof buildSessionsFileIndex>

// PTY viva neste app = sessão viva; o status vem do session file do CLI. PTY sem
// session file ainda é uma sessão que está subindo.
export function liveSessionStates(index: SessionsFileIndex): Map<string, LiveSessionState> {
  const running = ptyManager.runningIds()
  const rows = getDb()
    .prepare(`SELECT id, cc_session_id FROM sessions WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(running)) as Array<{ id: string; cc_session_id: string | null }>
  const out = new Map<string, LiveSessionState>()
  for (const row of rows) {
    // Sem id nativo (Codex): não há session file — o status é o da própria PTY.
    if (!row.cc_session_id) {
      out.set(row.id, {
        status: ptyStatusFor(row.id),
        lastActivityAt: ptyManager.getActivitySample(row.id)?.lastByteAt ?? null,
        name: null,
      })
      continue
    }
    const entry = index.get(row.cc_session_id)
    const alive = entry ? isPidAlive(entry.pid) : false
    out.set(row.id, {
      status: entry && alive ? mapStatus(entry.status) : 'starting',
      lastActivityAt: entry?.updatedAt ?? null,
      name: entry?.name ?? null,
    })
  }
  return out
}
