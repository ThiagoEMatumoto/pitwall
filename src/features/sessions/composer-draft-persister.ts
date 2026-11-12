import type {
  ComposerDraft,
  ComposerDraftAttachment,
  VersionedDraftInput,
} from '../../../shared/types/composer-draft'

// Persistência durável do rascunho do Composer, sem React: o Composer alimenta o
// estado a cada mudança e o persister grava no app.db em duas vias: cada mudança
// vai na hora ao main (writeThrough, commit NORMAL: sobrevive a kill -9) e o
// debounce grava com fsync (FULL: cobre queda de energia). Regras que protegem o
// trabalho do usuário:
//  - nada é gravado antes da hidratação: o estado do mount não pode sobrescrever
//    o rascunho que ainda está sendo lido;
//  - o Composer fica só-leitura até a leitura terminar; se ela estourar o teto
//    (DRAFT_HYDRATE_LOCK_MS) e o usuário digitar antes dela, salvo e digitado
//    são JUNTADOS (nenhum dos dois é descartado) e o Composer avisa;
//  - blur e troca de pane gravam na hora pelo flush assíncrono: não seguram o
//    renderer à espera do main;
//  - flushSync grava na hora por IPC síncrono (unload, pedido do main no
//    quit/exit, desmonte com mudança ainda não enviada): quando retorna, o
//    commit já aconteceu, inclusive o de um flush assíncrono ainda em voo;
//  - a remoção só acontece depois do envio confirmado (sendThenClear) ou porque
//    o usuário esvaziou o texto à mão.

export interface DraftState {
  text: string
  attachments: ComposerDraftAttachment[]
}

export interface DraftApi {
  get(key: string): Promise<ComposerDraft | null>
  // Síncronos (ipcRenderer.sendSync): retornam depois do commit no main.
  getSync(key: string): ComposerDraft | null
  save(draft: VersionedDraftInput): Promise<void>
  saveSync(draft: VersionedDraftInput): void
  // Fire-and-forget, uma por mudança (ipcRenderer.send: FIFO, não bloqueia a tecla).
  writeThrough(draft: VersionedDraftInput): void
  clear(key: string): Promise<void>
}

export const DRAFT_DEBOUNCE_MS = 500
// Teto do campo só-leitura à espera da leitura do rascunho salvo: se o main não
// responder, o Composer destrava e a junção salvo + digitado volta a valer.
export const DRAFT_HYDRATE_LOCK_MS = 1000

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

function sameState(a: DraftState, b: DraftState): boolean {
  return a.text === b.text && sameAttachments(a.attachments, b.attachments)
}

// Salvo primeiro (é o mais antigo), depois o que foi digitado antes da leitura.
export function mergeDrafts(saved: DraftState, typed: DraftState): DraftState {
  const text =
    saved.text.length === 0
      ? typed.text
      : typed.text.length === 0
        ? saved.text
        : `${saved.text}\n\n${typed.text}`
  const extra = typed.attachments.filter((t) => !saved.attachments.some((s) => s.path === t.path))
  return { text, attachments: [...saved.attachments, ...extra] }
}

// `merged` = o salvo foi juntado ao que o usuário digitou antes da leitura.
export type ApplyDraft = (state: DraftState, merged: boolean) => void

export interface DraftPersister {
  // Lê o rascunho salvo e o entrega ao `apply` (direto, ou juntado ao digitado).
  // Resolve false quando a leitura falhou: o salvo continua desconhecido.
  hydrate(apply: ApplyDraft): Promise<boolean>
  // Estado em memória do mesmo processo (remount): é mais novo que o banco, então
  // dispensa a leitura e vale como hidratado.
  seed(state: DraftState): void
  update(state: DraftState): void
  // Grava agora o que estiver pendente, assíncrono.
  flush(): Promise<void>
  // Grava agora, síncrono: ao retornar, o rascunho já está commitado.
  flushSync(): void
  // Envia e, SÓ se `send` confirmar (resolver true), remove o rascunho enviado.
  // Falha (false ou throw) mantém o rascunho intacto.
  sendThenClear(sentText: string, send: () => Promise<boolean>): Promise<boolean>
  // Desmonte: grava o pendente síncrono e para de aplicar na UI. Devolve a junção
  // salvo + digitado quando foi o próprio desmonte que leu o salvo (a leitura
  // assíncrona não tinha voltado): a UI não a recebeu, quem desmonta a guarda.
  dispose(): DraftState | null
}

// Persisters vivos, para o flush global (beforeunload, troca de pane, pedido do main).
const live = new Set<DraftPersister>()

// Blur e troca de pane: o invoke de cada persister sai nesta chamada, sem
// bloquear o renderer à espera do main.
export async function flushAllDrafts(): Promise<void> {
  await Promise.all([...live].map((p) => p.flush()))
}

// Só no unload e no pedido do main (quit/exit): bloqueia até o commit.
export function flushAllDraftsSync(): void {
  for (const p of live) {
    try {
      p.flushSync()
    } catch (err) {
      console.error('[composer] flush síncrono falhou:', err)
    }
  }
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
  let apply: ApplyDraft | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  // Saves assíncronos em voo: o commit deles ainda não foi confirmado.
  let saving = 0
  // Versão monotônica deste persister: o main descarta versão antiga do mesmo writer.
  const writer = newWriterId()
  let seq = 0

  function cancelTimer() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function draftInput(k: string): VersionedDraftInput {
    return { key: k, ccSessionId, paneId, ...latest, writer, seq }
  }

  // Nova versão de `latest`: vai já ao main (antes do debounce FULL).
  function changed(state: DraftState) {
    latest = state
    seq++
    dirty = true
    if (!key || !hydrated) return
    try {
      api.writeThrough(draftInput(key))
    } catch (err) {
      console.error('[composer] write-through do rascunho falhou:', err)
    }
    schedule()
  }

  async function write(): Promise<void> {
    cancelTimer()
    if (!key || !hydrated || !dirty) return
    dirty = false
    saving++
    try {
      await api.save(draftInput(key))
    } catch (err) {
      dirty = true
      console.error('[composer] falha ao gravar o rascunho:', err)
    } finally {
      saving--
    }
  }

  function schedule() {
    if (disposed) return
    cancelTimer()
    timer = setTimeout(() => void write(), delayMs)
  }

  // Primeira resolução vence (a leitura assíncrona ou a síncrona do flush).
  function resolveSaved(saved: ComposerDraft | null) {
    if (hydrated) return
    hydrated = true
    if (saved) {
      const stored: DraftState = { text: saved.text, attachments: saved.attachments }
      if (!dirty && isEmpty(latest)) {
        latest = stored
        if (!disposed) apply?.(stored, false)
      } else if (!sameState(stored, latest)) {
        changed(mergeDrafts(stored, latest))
        if (!disposed) apply?.(latest, true)
        return
      }
    }
    if (dirty) changed(latest)
  }

  function flushSync(): void {
    if (!key) return
    if (!hydrated) {
      if (!dirty) return
      // Digitou antes da leitura: sem saber o salvo, gravar o digitado o apagaria.
      try {
        resolveSaved(api.getSync(key))
      } catch (err) {
        console.error('[composer] leitura síncrona do rascunho falhou; não gravo:', err)
        return
      }
    }
    cancelTimer()
    if (!dirty && saving === 0) return
    dirty = false
    try {
      api.saveSync(draftInput(key))
    } catch (err) {
      dirty = true
      console.error('[composer] falha ao gravar o rascunho (síncrono):', err)
      schedule()
    }
  }

  const persister: DraftPersister = {
    async hydrate(fn) {
      apply = fn
      if (!key) {
        hydrated = true
        return true
      }
      let saved: ComposerDraft | null = null
      let read = true
      try {
        saved = await api.get(key)
      } catch (err) {
        read = false
        console.error('[composer] falha ao ler o rascunho salvo:', err)
      }
      resolveSaved(saved)
      return read
    },

    seed(state) {
      hydrated = true
      // Remount de pane já lida e vazia: o banco também está vazio, nada a gravar.
      if (!sameState(state, latest)) changed(state)
    },

    update(state) {
      if (sameState(state, latest)) return
      changed(state)
    },

    flush: write,
    flushSync,

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

    dispose() {
      disposed = true
      live.delete(persister)
      const unread = !hydrated
      // Save em voo já está na fila do IPC e o renderer segue vivo: só o que
      // ainda não saiu vai pelo síncrono.
      if (dirty) flushSync()
      // O síncrono falhou: última tentativa pelo caminho assíncrono.
      if (dirty) void write()
      return unread && hydrated ? latest : null
    },
  }
  live.add(persister)
  return persister
}

function sameAttachments(a: ComposerDraftAttachment[], b: ComposerDraftAttachment[]): boolean {
  return a.length === b.length && a.every((x, i) => x.path === b[i].path && x.name === b[i].name)
}

function newWriterId(): string {
  return globalThis.crypto.randomUUID()
}
