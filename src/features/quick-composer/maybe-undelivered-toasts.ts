import { useEffect } from 'react'
import { sendToApi, sessionsApi } from '@/lib/ipc'
import { dismissToast, showToast } from '@/features/notifications/toast-store'
import { useAppStore } from '@/store/appStore'
import type { PromptQueueSnapshot, QueuedPrompt } from '../../../shared/types/send-prompt'

export interface MaybeUndeliveredDeps {
  queue: () => Promise<PromptQueueSnapshot>
  onQueueUpdated: (handler: (snapshot: PromptQueueSnapshot) => void) => () => void
  resend: (id: string) => Promise<boolean>
  cancel: (id: string) => Promise<boolean>
  titleOf: (sessionId: string) => Promise<string | null>
  show: typeof showToast
  dismiss: typeof dismissToast
}

// "Talvez não entregue — reenviar?". Sincroniza pelos itens do snapshot, não pelo
// lastEvent: o boot pode marcar vários itens antes do renderer subir e o lastEvent
// só guarda o último.
export function watchMaybeUndelivered(deps: MaybeUndeliveredDeps): () => void {
  const toastOf = new Map<string, number>()
  // Já decididos (ou em resolução de título): um snapshot que chega antes do IPC
  // terminar não pode reabrir o toast.
  const seen = new Set<string>()
  let disposed = false

  const decide = (id: string, action: (id: string) => Promise<boolean>, label: string) => {
    toastOf.delete(id)
    action(id).catch((err) => console.error(`[prompt-queue] ${label} falhou:`, err))
  }

  const open = async (item: QueuedPrompt) => {
    seen.add(item.id)
    const title = await deps.titleOf(item.sessionId).catch(() => null)
    if (disposed) return
    const toastId = deps.show({
      title: `Mensagem para ${title ?? 'a sessão'} talvez não tenha sido entregue`,
      body: item.text.slice(0, 160),
      actionLabel: 'Reenviar',
      onAction: () => decide(item.id, deps.resend, 'resend'),
      secondaryActionLabel: 'Descartar',
      onSecondaryAction: () => decide(item.id, deps.cancel, 'cancel'),
      persistent: true,
    })
    toastOf.set(item.id, toastId)
  }

  const sync = (snapshot: PromptQueueSnapshot) => {
    if (disposed) return
    const pending = new Set(
      snapshot.items.filter((i) => i.recovery === 'maybe-undelivered').map((i) => i.id),
    )
    for (const item of snapshot.items) {
      if (pending.has(item.id) && !seen.has(item.id)) void open(item)
    }
    // Resolvido por outro caminho (agent bus, outra janela): o toast perdeu o sentido.
    for (const [id, toastId] of toastOf) {
      if (pending.has(id)) continue
      deps.dismiss(toastId)
      toastOf.delete(id)
    }
  }

  const off = deps.onQueueUpdated(sync)
  deps
    .queue()
    .then(sync)
    .catch((err) => console.error('[prompt-queue] snapshot inicial falhou:', err))

  return () => {
    disposed = true
    off()
  }
}

// O sessionId do item é a PTY de quando foi aceito, em geral já morta: o título
// vem da linha em sessions, que sobrevive.
async function sessionTitle(sessionId: string): Promise<string | null> {
  const live = useAppStore.getState().liveSessions.find((s) => s.id === sessionId)
  if (live) return live.title ?? live.name ?? null
  const row = (await sessionsApi.list()).find((s) => s.id === sessionId)
  return row?.title ?? null
}

export function useMaybeUndeliveredToasts(): void {
  useEffect(
    () =>
      watchMaybeUndelivered({
        queue: () => sendToApi.queue(),
        onQueueUpdated: (h) => sendToApi.onQueueUpdated(h),
        resend: (id) => sendToApi.resend(id),
        cancel: (id) => sendToApi.cancel(id),
        titleOf: sessionTitle,
        show: showToast,
        dismiss: dismissToast,
      }),
    [],
  )
}
