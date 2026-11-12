import type { PtyDataEvent } from './pty-manager'

export const PTY_DATA_WINDOW_MS = 8

export interface PtyDataCoalescer {
  push(sessionId: string, data: string): void
  // Envia agora o que a janela ainda segura. Quem lê o backlog ou anuncia a saída
  // da PTY chama antes: o renderer assume que tudo que já está no backlog foi
  // entregue antes da resposta, e o que chegasse depois duplicaria na tela.
  flush(sessionId: string): void
  drop(sessionId: string): void
}

// Borda inicial: o chunk de uma sessão ociosa sai na hora (eco de tecla sem
// latência extra) e abre a janela; o que chega dentro dela sai junto no fim, e
// só a janela que fecha vazia não rearma. Um debounce puro nunca dispararia com
// a sessão emitindo sem parar.
export function createPtyDataCoalescer(
  send: (e: PtyDataEvent) => void,
  windowMs = PTY_DATA_WINDOW_MS,
): PtyDataCoalescer {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pending = new Map<string, string>()

  const flush = (sessionId: string): void => {
    const data = pending.get(sessionId)
    if (!data) return
    pending.delete(sessionId)
    send({ sessionId, data })
  }

  // Sempre arma antes de enviar: se o send lançar (janela destruída), a sessão
  // não fica com uma janela que nunca fecha, acumulando para sempre.
  const openWindow = (sessionId: string): void => {
    timers.set(
      sessionId,
      setTimeout(() => {
        if (!pending.get(sessionId)) {
          timers.delete(sessionId)
          return
        }
        openWindow(sessionId)
        flush(sessionId)
      }, windowMs),
    )
  }

  return {
    push(sessionId, data) {
      if (timers.has(sessionId)) {
        pending.set(sessionId, (pending.get(sessionId) ?? '') + data)
        return
      }
      openWindow(sessionId)
      send({ sessionId, data })
    },
    flush,
    drop(sessionId) {
      const timer = timers.get(sessionId)
      if (timer) clearTimeout(timer)
      timers.delete(sessionId)
      pending.delete(sessionId)
    },
  }
}
