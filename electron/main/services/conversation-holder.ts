import { getDb } from './db'
import { openElsewhereError } from './dormant-panes'
import { ptyManager } from './pty-manager'
import { buildSessionsFileIndex, isPidAlive } from './session-activity'

// Processo vivo FORA do Pitwall segurando a conversa (claude aberto num terminal
// comum, outra instância do app). Um --resume do mesmo id escreveria no mesmo
// JSONL com dois processos. Fonte: ~/.claude/sessions/<pid>.json.
//
// "Do Pitwall" = alguma linha de sessions com este cc tem PTY viva. Decidido pela
// conversa, não pelo pid: o ptyManager não expõe pid e, no Windows, a PTY é o
// powershell que lançou o claude.
export function foreignHolderPid(ccSessionId: string): number | null {
  const entry = buildSessionsFileIndex().get(ccSessionId)
  if (!entry || !isPidAlive(entry.pid)) return null
  const rows = getDb()
    .prepare('SELECT id FROM sessions WHERE cc_session_id = ?')
    .all(ccSessionId) as Array<{ id: string }>
  if (rows.some((r) => ptyManager.isRunning(r.id))) return null
  return entry.pid
}

export function assertNotOpenElsewhere(ccSessionId: string): void {
  const pid = foreignHolderPid(ccSessionId)
  if (pid !== null) throw new Error(openElsewhereError(pid))
}
