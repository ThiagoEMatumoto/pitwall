import type Database from 'better-sqlite3'
import type { VersionedDraftInput } from '../../../shared/types/composer-draft'
import { saveComposerDraft, saveComposerDraftsFast } from './composer-drafts'

// Write-through do rascunho: o renderer manda CADA mudança (ipcRenderer.send) e
// o main grava em synchronous=NORMAL, que sobrevive a kill -9. O save FULL do
// debounce (e o flush síncrono) passa por aqui também, para as duas vias
// respeitarem a mesma ordem.
//
// Coalescência com borda de subida: a primeira mudança de um tick grava NA HORA
// (a tecla isolada, caso comum, não fica esperando em memória); as que chegam no
// mesmo tick ficam só com a última por chave e vão num único commit no
// setImmediate seguinte.
//
// Ordem: o IPC de uma janela é FIFO, e toda operação de rascunho drena o
// pendente antes de rodar, então o main aplica na ordem de chegada. A guarda de
// versão é a segunda linha: do mesmo writer, seq menor que a última gravada
// nunca sobrescreve (seq igual passa: é o save FULL da mesma versão).
export interface DraftWriteThrough {
  // Via rápida (NORMAL), uma por mudança.
  write(draft: VersionedDraftInput): void
  // Via durável (FULL): debounce, blur, quit.
  saveDurable(draft: VersionedDraftInput): void
  // Grava agora o que estiver coalescido; chamar antes de qualquer outra
  // operação sobre rascunhos.
  drain(): void
}

type Version = Pick<VersionedDraftInput, 'writer' | 'seq'>

export function createDraftWriteThrough(
  getDb: () => Database.Database,
  defer: (fn: () => void) => void = setImmediate,
): DraftWriteThrough {
  const pending = new Map<string, VersionedDraftInput>()
  const committed = new Map<string, Version>()
  let burst = false

  function isOlder(draft: VersionedDraftInput, than: Version | undefined): boolean {
    return !!than && than.writer === draft.writer && draft.seq < than.seq
  }

  function commitFast(drafts: VersionedDraftInput[]): void {
    const fresh = drafts.filter((d) => !isOlder(d, committed.get(d.key)))
    if (fresh.length === 0) return
    saveComposerDraftsFast(getDb(), fresh)
    for (const d of fresh) committed.set(d.key, { writer: d.writer, seq: d.seq })
  }

  function drain(): void {
    if (pending.size === 0) return
    const batch = [...pending.values()]
    pending.clear()
    commitFast(batch)
  }

  function endBurst(): void {
    burst = false
    try {
      drain()
    } catch (err) {
      console.error('[composer] write-through coalescido falhou:', err)
    }
  }

  return {
    write(draft) {
      if (!burst) {
        burst = true
        defer(endBurst)
        commitFast([draft])
        return
      }
      if (isOlder(draft, pending.get(draft.key))) return
      pending.set(draft.key, draft)
    },

    saveDurable(draft) {
      drain()
      if (isOlder(draft, committed.get(draft.key))) return
      saveComposerDraft(getDb(), draft)
      committed.set(draft.key, { writer: draft.writer, seq: draft.seq })
    },

    drain,
  }
}
