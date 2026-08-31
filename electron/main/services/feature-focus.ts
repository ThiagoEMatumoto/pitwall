import { getDb } from './db'
import type { FeatureDuplicateSuspect, FeatureFocus } from '../../../shared/types/ipc'

// Foco da parede de features (migration 043): o que o humano puxou pra frente
// (pinned/focus_rank) e o que o auto-registro desconfia ser repetido
// (duplicate_of/duplicate_score). Só I/O, no molde de loop-store.
//
// Mora aqui e não em feature-store porque aquele arquivo carrega o watcher do
// `.md` e o round-trip de frontmatter; nada disto vive no doc — pin e suspeita
// são estado do índice, como archived_at e origin.
//
// NENHUMA escrita daqui carimba features.updated_at, de propósito: a vitalidade
// é derivada do último toque REAL na feature (loop.livenessOf). Fixar um card na
// parede não é trabalho na feature — bumpar updated_at faria uma frente
// abandonada parecer viva só porque alguém a fixou.

interface FocusRow {
  pinned: number
  focus_rank: number | null
  duplicate_of: string | null
  duplicate_score: number | null
}

function rowOf(featureId: string): FocusRow | undefined {
  return getDb()
    .prepare(
      'SELECT pinned, focus_rank, duplicate_of, duplicate_score FROM features WHERE id = ?',
    )
    .get(featureId) as FocusRow | undefined
}

export function readFocus(featureId: string): FeatureFocus {
  const row = rowOf(featureId)
  if (!row) throw new Error(`feature not found: ${featureId}`)
  return { featureId, pinned: !!row.pinned, focusRank: row.focus_rank }
}

/**
 * Fixa/desafixa e/ou reposiciona a feature na parede. Campos ausentes ficam
 * como estavam (patch parcial) — a UI manda só o que o gesto mudou: o botão de
 * pin não conhece o rank, o arrasto não muda o pin.
 */
export function setFocus(
  featureId: string,
  patch: { pinned?: boolean; focusRank?: number | null },
): FeatureFocus {
  const current = readFocus(featureId)
  const pinned = patch.pinned ?? current.pinned
  const focusRank = patch.focusRank === undefined ? current.focusRank : patch.focusRank
  getDb()
    .prepare('UPDATE features SET pinned = ?, focus_rank = ? WHERE id = ?')
    .run(pinned ? 1 : 0, focusRank, featureId)
  return { featureId, pinned, focusRank }
}

/**
 * Marca que este rascunho PARECE o candidato (faixa do meio do fuzzy). Não
 * decide nada: só guarda o par pra `issuesOf` derivar o aviso e a UI oferecer o
 * merge. Idempotente — regravar o mesmo par só atualiza o score.
 */
export function markDuplicateSuspect(featureId: string, candidateId: string, score: number): void {
  // Uma feature suspeita dela mesma não significa nada e a FK aceitaria.
  if (featureId === candidateId) return
  getDb()
    .prepare('UPDATE features SET duplicate_of = ?, duplicate_score = ? WHERE id = ?')
    .run(candidateId, score, featureId)
}

/** Dispensa a suspeita ("não é duplicata"). Nada é apagado além do ponteiro. */
export function clearDuplicateSuspect(featureId: string): void {
  getDb()
    .prepare('UPDATE features SET duplicate_of = NULL, duplicate_score = NULL WHERE id = ?')
    .run(featureId)
}

/**
 * A suspeita pronta pra leitura, com o TÍTULO do candidato resolvido — a UI
 * precisa dizer «possível duplicata de X», e quem tem a tabela é aqui.
 * Um candidato apagado zera duplicate_of (ON DELETE SET NULL), então null aqui
 * significa mesmo "sem suspeita".
 */
export function duplicateSuspectOf(featureId: string): FeatureDuplicateSuspect | null {
  const row = rowOf(featureId)
  if (!row?.duplicate_of) return null
  const candidate = getDb()
    .prepare('SELECT title FROM features WHERE id = ?')
    .get(row.duplicate_of) as { title: string } | undefined
  return {
    candidateId: row.duplicate_of,
    title: candidate?.title ?? null,
    score: row.duplicate_score,
  }
}

/**
 * Absorve o rascunho suspeito na feature de destino: sessões e registros passam
 * a apontar pro destino, os repos do rascunho são adotados, e a origem é
 * ARQUIVADA — nunca apagada (norma do projeto; arquivar é reversível, DELETE
 * levaria junto os registros por cascade).
 *
 * O `.md` da origem fica no disco de propósito: o corpo é fonte de verdade e o
 * reindex do watcher a traria de volta como row arquivada, não como perda.
 */
export function mergeDuplicate(sourceId: string, targetId: string): void {
  if (sourceId === targetId) throw new Error('cannot merge a feature into itself')
  const db = getDb()
  if (!rowOf(sourceId)) throw new Error(`feature not found: ${sourceId}`)
  if (!rowOf(targetId)) throw new Error(`feature not found: ${targetId}`)
  const now = Date.now()
  const tx = db.transaction(() => {
    db.prepare('UPDATE sessions SET feature_id = ? WHERE feature_id = ?').run(targetId, sourceId)
    db.prepare('UPDATE feature_session_records SET feature_id = ? WHERE feature_id = ?').run(
      targetId,
      sourceId,
    )
    // OR IGNORE: o par (feature_id, repo_id) é PK — repo já adotado fica como está.
    db.prepare(
      `INSERT OR IGNORE INTO feature_repos (feature_id, repo_id, branch, worktree_path)
         SELECT ?, repo_id, branch, worktree_path FROM feature_repos WHERE feature_id = ?`,
    ).run(targetId, sourceId)
    db.prepare('UPDATE features SET archived_at = ?, updated_at = ?, pinned = 0 WHERE id = ?').run(
      now,
      now,
      sourceId,
    )
    // A suspeita morre com o merge — dos dois lados, se alguém apontava pra origem.
    db.prepare(
      'UPDATE features SET duplicate_of = NULL, duplicate_score = NULL WHERE id = ? OR duplicate_of = ?',
    ).run(sourceId, sourceId)
    // Aqui SIM o updated_at do destino sobe: ele absorveu trabalho real.
    db.prepare('UPDATE features SET updated_at = ? WHERE id = ?').run(now, targetId)
  })
  tx()
}
