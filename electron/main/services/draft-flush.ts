// Pedido de flush dos rascunhos do Composer ao renderer: o debounce de 500ms do
// renderer deixa uma janela em que o digitado ainda não está no app.db. Antes de
// fechar o app (before-quit) ou de apagar imagens de uma sessão que saiu (exit),
// o main pede o flush síncrono a cada janela que usa rascunho e espera o ack,
// com teto curto: renderer travado não pode segurar o quit.
//
// Sem electron: a janela chega como DraftFlushTarget (webContents no app).
import { randomUUID } from 'node:crypto'

export const DRAFT_FLUSH_TIMEOUT_MS = 1500
export const DRAFT_FLUSH_REQUEST_CHANNEL = 'composer:flush-request'

export interface DraftFlushTarget {
  id: number
  isDestroyed(): boolean
  send(channel: string, requestId: string): void
}

export interface DraftFlushCoordinator {
  // Janela que usou a API de rascunho: tem (ou teve) Composer montado.
  remember(target: DraftFlushTarget): void
  // true = todas as janelas confirmaram o flush; false = timeout ou falha de envio.
  request(timeoutMs?: number): Promise<boolean>
  ack(requestId: string, senderId: number): void
}

export function createDraftFlushCoordinator(): DraftFlushCoordinator {
  const clients = new Map<number, DraftFlushTarget>()
  const pending = new Map<string, { waiting: Set<number>; done: () => void }>()

  function aliveTargets(): DraftFlushTarget[] {
    for (const [id, t] of clients) if (t.isDestroyed()) clients.delete(id)
    return [...clients.values()]
  }

  return {
    remember(target) {
      clients.set(target.id, target)
    },

    request(timeoutMs = DRAFT_FLUSH_TIMEOUT_MS) {
      const targets = aliveTargets()
      if (targets.length === 0) return Promise.resolve(true)
      const requestId = randomUUID()
      return new Promise<boolean>((resolve) => {
        const waiting = new Set(targets.map((t) => t.id))
        let failed = false
        const finish = (ok: boolean) => {
          clearTimeout(timer)
          pending.delete(requestId)
          resolve(ok)
        }
        const timer = setTimeout(() => finish(false), timeoutMs)
        pending.set(requestId, { waiting, done: () => finish(!failed) })
        for (const t of targets) {
          try {
            t.send(DRAFT_FLUSH_REQUEST_CHANNEL, requestId)
          } catch (err) {
            failed = true
            waiting.delete(t.id)
            console.error('[composer] pedido de flush não chegou à janela:', err)
          }
        }
        if (waiting.size === 0) finish(!failed)
      })
    },

    ack(requestId, senderId) {
      const p = pending.get(requestId)
      if (!p) return
      p.waiting.delete(senderId)
      if (p.waiting.size === 0) p.done()
    },
  }
}

// Sequência do before-quit: o flush dos rascunhos (já limitado pelo próprio
// timeout) corre junto com o flush do sync (limitado aqui). Resolve quando os
// dois terminam; só então o main fecha o DB.
export async function flushBeforeQuit(deps: {
  flushDrafts: () => Promise<boolean>
  flushSync: () => Promise<void>
  syncTimeoutMs: number
}): Promise<void> {
  const sync = deps.flushSync().catch((err) => {
    console.warn('[sync] flush no quit falhou (não-fatal):', String((err as Error)?.message ?? err))
  })
  const boundedSync = Promise.race([
    sync,
    new Promise<void>((resolve) => setTimeout(resolve, deps.syncTimeoutMs)),
  ])
  const drafts = deps.flushDrafts().then(
    (ok) => {
      if (!ok) console.warn('[composer] flush dos rascunhos no quit não confirmou a tempo')
    },
    (err) => console.error('[composer] flush dos rascunhos no quit falhou:', err),
  )
  await Promise.all([drafts, boundedSync])
}
