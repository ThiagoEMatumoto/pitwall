import type Database from 'better-sqlite3'
import type { VersionedDraftInput } from '../../../shared/types/composer-draft'
import { saveComposerDraft, saveComposerDraftsFast } from './composer-drafts'

// Write-through do rascunho: o renderer manda CADA mudança (ipcRenderer.send) e
// o main grava em synchronous=NORMAL, que sobrevive a kill -9. O save FULL do
// debounce (e o flush síncrono) passa por aqui também, para as duas vias
// respeitarem a mesma ordem.
//
// O handler do IPC NUNCA grava: roda na thread do main que repassa os dados de
// todas as PTYs, e um commit de rascunho grande (1MB) custa ms. Ele só guarda a
// última versão por chave e agenda o flush fora do caminho de I/O: setImmediate
// se o último commit foi há DRAFT_COALESCE_MS ou mais, senão um timer até
// completar o intervalo. Assim sai no máximo 1 commit NORMAL a cada
// DRAFT_COALESCE_MS (um commit leva todas as chaves pendentes), sempre do último
// estado. Nada de fsync aqui: o FULL fica no debounce de 500ms do renderer e nos
// flushes (blur, troca de pane, beforeunload, before-quit), e todos drenam o
// pendente antes.
//
// Janela de perda em kill -9: as mudanças ainda pendentes, ou seja, até
// DRAFT_COALESCE_MS (mais o atraso do event loop do main) depois da última
// tecla. O que já foi commitado está no WAL, no page cache do kernel.
//
// Ordem: o IPC de uma janela é FIFO, e toda operação de rascunho drena o
// pendente antes de rodar, então o main aplica na ordem de chegada. A guarda de
// versão é a segunda linha: do mesmo writer, seq menor que a última gravada
// nunca sobrescreve (seq igual passa: é o save FULL da mesma versão).
export interface DraftWriteThrough {
  // Via rápida (NORMAL): chamada a cada mudança. Não grava: agenda o flush.
  write(draft: VersionedDraftInput): void
  // Via durável (FULL): debounce, blur, quit.
  saveDurable(draft: VersionedDraftInput): void
  // Grava agora o que estiver pendente; chamar antes de qualquer outra
  // operação sobre rascunhos.
  drain(): void
}

type Version = Pick<VersionedDraftInput, 'writer' | 'seq'>

export const DRAFT_COALESCE_MS = 100

export type DraftFlushScheduler = (fn: () => void, delayMs: number) => void

const scheduleOffIo: DraftFlushScheduler = (fn, delayMs) => {
  if (delayMs <= 0) setImmediate(fn)
  else setTimeout(fn, delayMs)
}

export function createDraftWriteThrough(
  getDb: () => Database.Database,
  schedule: DraftFlushScheduler = scheduleOffIo,
  now: () => number = Date.now,
): DraftWriteThrough {
  const pending = new Map<string, VersionedDraftInput>()
  const committed = new Map<string, Version>()
  let flushScheduled = false
  let lastCommitAt = -Infinity

  function isOlder(draft: VersionedDraftInput, than: Version | undefined): boolean {
    return !!than && than.writer === draft.writer && draft.seq < than.seq
  }

  function commitFast(drafts: VersionedDraftInput[]): void {
    const fresh = drafts.filter((d) => !isOlder(d, committed.get(d.key)))
    if (fresh.length === 0) return
    saveComposerDraftsFast(getDb(), fresh)
    lastCommitAt = now()
    for (const d of fresh) committed.set(d.key, { writer: d.writer, seq: d.seq })
  }

  function drain(): void {
    if (pending.size === 0) return
    const batch = [...pending.values()]
    pending.clear()
    commitFast(batch)
  }

  function scheduledFlush(): void {
    flushScheduled = false
    try {
      drain()
    } catch (err) {
      console.error('[composer] write-through coalescido falhou:', err)
    }
  }

  return {
    write(draft) {
      if (isOlder(draft, pending.get(draft.key))) return
      pending.set(draft.key, draft)
      if (flushScheduled) return
      flushScheduled = true
      schedule(scheduledFlush, lastCommitAt + DRAFT_COALESCE_MS - now())
    },

    saveDurable(draft) {
      drain()
      if (isOlder(draft, committed.get(draft.key))) return
      saveComposerDraft(getDb(), draft)
      committed.set(draft.key, { writer: draft.writer, seq: draft.seq })
    },

    drain() {
      drain()
    },
  }
}
