import type {
  ComposerDraft,
  ComposerDraftAttachment,
  ComposerDraftInput,
} from '../../../shared/types/composer-draft'

// Persistência durável do rascunho do Composer, sem React: o Composer alimenta o
// estado a cada mudança e o persister grava no app.db com debounce. Regras que
// protegem o trabalho do usuário:
//  - nada é gravado antes da hidratação: o estado vazio do mount não pode
//    apagar o rascunho que ainda está sendo lido;
//  - a remoção só acontece depois do envio confirmado (sendThenClear) ou porque
//    o usuário esvaziou o texto à mão.

export interface DraftState {
  text: string
  attachments: ComposerDraftAttachment[]
}

export interface DraftApi {
  get(key: string): Promise<ComposerDraft | null>
  save(draft: ComposerDraftInput): Promise<void>
  clear(key: string): Promise<void>
}

export const DRAFT_DEBOUNCE_MS = 500

// 'pane:<id>' atravessa o restore (inclusive a sessão sem transcript que renasce
// com outro cc no mesmo paneId); sem pane (quick look), o cc identifica a conversa.
export function composerDraftKey(paneId: string | null, ccSessionId: string | null): string | null {
  if (paneId) return `pane:${paneId}`
  if (ccSessionId) return `cc:${ccSessionId}`
  return null
}

function isEmpty(s: DraftState): boolean {
  return s.text.length === 0 && s.attachments.length === 0
}

export interface DraftPersister {
  // Lê o rascunho salvo; `apply` só é chamado se o usuário ainda não mexeu.
  hydrate(apply: (draft: ComposerDraft) => void): Promise<void>
  update(state: DraftState): void
  // Grava agora o que estiver pendente (unmount/desmontagem da pane).
  flush(): Promise<void>
  // Envia e, SÓ se `send` confirmar (resolver true), remove o rascunho enviado.
  // Falha (false ou throw) mantém o rascunho intacto.
  sendThenClear(sentText: string, send: () => Promise<boolean>): Promise<boolean>
  dispose(): Promise<void>
}

export function createDraftPersister(opts: {
  key: string | null
  ccSessionId: string | null
  paneId: string | null
  api: DraftApi
  delayMs?: number
}): DraftPersister {
  const { key, ccSessionId, paneId, api } = opts
  const delayMs = opts.delayMs ?? DRAFT_DEBOUNCE_MS
  let latest: DraftState = { text: '', attachments: [] }
  let hydrated = false
  let dirty = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function cancelTimer() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  async function write(): Promise<void> {
    cancelTimer()
    if (!key || !hydrated || !dirty) return
    dirty = false
    const state = latest
    try {
      await api.save({ key, ccSessionId, paneId, ...state })
    } catch (err) {
      dirty = true
      console.error('[composer] falha ao gravar o rascunho:', err)
    }
  }

  function schedule() {
    if (disposed) return
    cancelTimer()
    timer = setTimeout(() => void write(), delayMs)
  }

  return {
    async hydrate(apply) {
      if (!key) {
        hydrated = true
        return
      }
      try {
        const saved = await api.get(key)
        if (saved && !disposed && !dirty && isEmpty(latest)) {
          latest = { text: saved.text, attachments: saved.attachments }
          apply(saved)
        }
      } catch (err) {
        console.error('[composer] falha ao ler o rascunho salvo:', err)
      } finally {
        hydrated = true
        if (dirty) schedule()
      }
    },

    update(state) {
      if (state.text === latest.text && sameAttachments(state.attachments, latest.attachments)) {
        return
      }
      latest = state
      dirty = true
      if (hydrated) schedule()
    },

    flush: write,

    async sendThenClear(sentText, send) {
      let ok = false
      try {
        ok = await send()
      } catch (err) {
        console.error('[composer] envio falhou; rascunho mantido:', err)
      }
      if (!ok || !key) return ok
      cancelTimer()
      try {
        // Digitou durante o envio: o que sobrou é o novo rascunho, não some.
        if (latest.text !== sentText && latest.text.length > 0) {
          dirty = true
          await write()
        } else {
          latest = { text: '', attachments: [] }
          dirty = false
          await api.clear(key)
        }
      } catch (err) {
        console.error('[composer] falha ao limpar o rascunho enviado:', err)
      }
      return ok
    },

    async dispose() {
      await write()
      disposed = true
    },
  }
}

function sameAttachments(a: ComposerDraftAttachment[], b: ComposerDraftAttachment[]): boolean {
  return a.length === b.length && a.every((x, i) => x.path === b[i].path && x.name === b[i].name)
}
