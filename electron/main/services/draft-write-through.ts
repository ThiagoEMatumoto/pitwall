import type Database from 'better-sqlite3'
import type { VersionedDraftInput } from '../../../shared/types/composer-draft'
import { saveComposerDraft, saveComposerDraftsFast } from './composer-drafts'

// Write-through do rascunho: o renderer manda CADA mudança (ipcRenderer.send) e
// o main grava em synchronous=NORMAL, que sobrevive a kill -9. O save FULL do
// debounce (e o flush síncrono) passa por aqui também, para as duas vias
// respeitarem a mesma ordem.
//
// Coalescência no tempo (throttle com borda de subida), porque cada tecla chega
// como uma mensagem IPC separada e roda na thread do main que repassa as PTYs:
// a primeira mudança com a janela fechada grava NA HORA e abre uma janela de
// DRAFT_COALESCE_MS; o que chega dentro dela fica só com a última versão por
// chave e vai num único commit quando a janela fecha. Se esse commit gravou algo,
// a janela reabre, então são no máximo ~1 commit NORMAL por janela, sempre do
// último estado. Nada de fsync aqui: o FULL fica no debounce de 500ms do renderer
// e nos flushes (blur, troca de pane, beforeunload, before-quit), e todos drenam
// o pendente antes.
//
// Janela de perda em kill -9: só as mudanças ainda pendentes, ou seja, até
// DRAFT_COALESCE_MS (mais o atraso do event loop do main) depois da última
// tecla. O que já foi commitado está no WAL, no page cache do kernel.
//
// Ordem: o IPC de uma janela é FIFO, e toda operação de rascunho drena o
// pendente antes de rodar, então o main aplica na ordem de chegada. A guarda de
// versão é a segunda linha: do mesmo writer, seq menor que a última gravada
// nunca sobrescreve (seq igual passa: é o save FULL da mesma versão).
export interface DraftWriteThrough {
  // Via rápida (NORMAL): chamada a cada mudança, no máximo um commit por janela.
  write(draft: VersionedDraftInput): void
  // Via durável (FULL): debounce, blur, quit.
  saveDurable(draft: VersionedDraftInput): void
  // Grava agora o que estiver coalescido; chamar antes de qualquer outra
  // operação sobre rascunhos.
  drain(): void
}

type Version = Pick<VersionedDraftInput, 'writer' | 'seq'>

export const DRAFT_COALESCE_MS = 50

const closeAfterWindow = (fn: () => void) => {
  setTimeout(fn, DRAFT_COALESCE_MS)
}

export function createDraftWriteThrough(
  getDb: () => Database.Database,
  defer: (fn: () => void) => void = closeAfterWindow,
): DraftWriteThrough {
  const pending = new Map<string, VersionedDraftInput>()
  const committed = new Map<string, Version>()
  let windowOpen = false

  function isOlder(draft: VersionedDraftInput, than: Version | undefined): boolean {
    return !!than && than.writer === draft.writer && draft.seq < than.seq
  }

  // true = gravou alguma coisa.
  function commitFast(drafts: VersionedDraftInput[]): boolean {
    const fresh = drafts.filter((d) => !isOlder(d, committed.get(d.key)))
    if (fresh.length === 0) return false
    saveComposerDraftsFast(getDb(), fresh)
    for (const d of fresh) committed.set(d.key, { writer: d.writer, seq: d.seq })
    return true
  }

  function drain(): boolean {
    if (pending.size === 0) return false
    const batch = [...pending.values()]
    pending.clear()
    return commitFast(batch)
  }

  function openWindow(): void {
    windowOpen = true
    defer(closeWindow)
  }

  function closeWindow(): void {
    windowOpen = false
    try {
      if (drain()) openWindow()
    } catch (err) {
      console.error('[composer] write-through coalescido falhou:', err)
    }
  }

  return {
    write(draft) {
      if (!windowOpen) {
        openWindow()
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

    drain() {
      drain()
    },
  }
}
