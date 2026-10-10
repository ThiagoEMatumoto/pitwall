import { getDb } from './db'
import { openElsewhereError } from './dormant-panes'
import { ptyManager } from './pty-manager'
import { buildSessionsFileIndex, isSessionPidAlive, type IndexEntry } from './session-activity'

type SessionsFileIndex = Map<string, IndexEntry>

export interface ConversationHolder {
  pid: number
  // sessions.id da PTY do Pitwall que segura a conversa; null = processo de fora.
  pitwallSessionId: string | null
}

// A linha de sessions guarda o cc do spawn e não acompanha /clear nem /resume
// dentro da TUI. Movida = o índice ~/.claude/sessions diz que o pid desta PTY
// está em OUTRA conversa. Pid ausente do índice (claude ainda subindo, Windows,
// onde a PTY é o shell) não desmente a linha.
export function ptyMovedToOtherConversation(
  sessionId: string,
  ccSessionId: string,
  index: SessionsFileIndex = buildSessionsFileIndex(),
): boolean {
  const pid = ptyManager.getPid(sessionId)
  if (pid === null) return false
  for (const [sid, entry] of index) if (entry.pid === pid) return sid !== ccSessionId
  return false
}

// Processo vivo segurando a conversa sem ser a PTY que o Pitwall reanexaria:
// claude aberto num terminal comum, outra instância do app, ou uma PTY do
// próprio Pitwall que chegou nela por /resume dentro da TUI (a linha dela aponta
// para outra conversa). Um --resume do mesmo id escreveria no mesmo JSONL com
// dois processos. Fonte: ~/.claude/sessions/<pid>.json.
export function conversationHolder(ccSessionId: string): ConversationHolder | null {
  const index = buildSessionsFileIndex()
  const entry = index.get(ccSessionId)
  if (!entry || !isSessionPidAlive(entry)) return null
  const pitwallSessionId = ptyManager.sessionIdByPid(entry.pid)
  if (pitwallSessionId) {
    const row = getDb()
      .prepare('SELECT cc_session_id FROM sessions WHERE id = ?')
      .get(pitwallSessionId) as { cc_session_id: string | null } | undefined
    return row?.cc_session_id === ccSessionId ? null : { pid: entry.pid, pitwallSessionId }
  }
  // Pid do índice que não é de PTY nossa. No Windows a PTY é o shell e o claude é
  // filho dele: vale a linha de sessions, salvo se o índice a desmente.
  const rows = getDb()
    .prepare('SELECT id FROM sessions WHERE cc_session_id = ?')
    .all(ccSessionId) as Array<{ id: string }>
  const ours = rows.some(
    (r) => ptyManager.isRunning(r.id) && !ptyMovedToOtherConversation(r.id, ccSessionId, index),
  )
  return ours ? null : { pid: entry.pid, pitwallSessionId: null }
}

export function foreignHolderPid(ccSessionId: string): number | null {
  return conversationHolder(ccSessionId)?.pid ?? null
}

// null = livre; senão o motivo da recusa, dizendo se o pid é de uma aba do Pitwall.
export function openElsewhereReason(ccSessionId: string): string | null {
  const holder = conversationHolder(ccSessionId)
  return holder ? openElsewhereError(holder.pid, holder.pitwallSessionId !== null) : null
}

export function assertNotOpenElsewhere(ccSessionId: string): void {
  const reason = openElsewhereReason(ccSessionId)
  if (reason !== null) throw new Error(reason)
}
