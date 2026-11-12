import type Database from 'better-sqlite3'
import { ENDED_BY_USER_ERROR } from './ended-by-user'

export const ORPHANED_AT_BOOT_ERROR = 'Sessão-filha órfã: app reiniciou sem reconciliar o handoff'

// Handoffs vivos (running OU needs_input) de um boot anterior são órfãos: a
// sessão-filha (PTY) não sobrevive ao restart, e a reconciliação via evento PTY
// exit nunca dispara (o ptyManager morreu junto). Sem isto, órfãos travam o dedup
// do repo-alvo para sempre. No boot TODO in-flight é órfão — nenhum PTY-filho
// sobrevive ao restart (inclui needs_input: a filha que perguntou também morreu
// junto com o app). Marca 'interrupted' (RECUPERÁVEL, não 'failed'): app-restart
// não é erro de tarefa; o handoff sai do ativo (libera o dedup) mas fica retomável
// pelo humano. Mantém em sync com failIfRunning / reconcileStuck (mesma transição
// em → interrupted).
//
// A filha que o usuário encerrou e cuja PTY morreu com o app (sem passar pelo exit
// handler) leva o mesmo motivo que o exit gravaria: é o que a mãe lê depois.
//
// Devolve quem estava em voo, lido ANTES do UPDATE: o lazy restore sobe eager a mãe
// e a filha desses handoffs, e depois do sweep eles são indistinguíveis de um
// 'interrupted' antigo (que não deve acordar nada no boot).
export function sweepInFlightHandoffs(db: Database.Database): string[] {
  const inFlight = db
    .prepare("SELECT id FROM handoffs WHERE status IN ('running','needs_input')")
    .all() as Array<{ id: string }>
  db.prepare(
    `UPDATE handoffs
        SET status = 'interrupted',
            error = CASE WHEN ended_by_user_at IS NOT NULL THEN ? ELSE ? END,
            updated_at = ?
      WHERE status IN ('running','needs_input')`,
  ).run(ENDED_BY_USER_ERROR, ORPHANED_AT_BOOT_ERROR, Date.now())
  return inFlight.map((r) => r.id)
}
