// Confirmação de pane antes do /exit: o open_panes que o gate lê tem debounce, e
// a aba pode ter fechado depois do último save. Mesmo padrão do wake-request /
// wake-result: o main pergunta ao renderer e espera a resposta com teto. Sem
// resposta = sem pane (fail-closed: a sessão não hiberna).
import { randomUUID } from 'node:crypto'
import type { PaneCheckRequest, PaneCheckResult } from '../../../../shared/hibernate'

export const PANE_CHECK_TIMEOUT_MS = 3_000

export interface PaneConfirmerDeps {
  // false = sem janela para perguntar.
  request(request: PaneCheckRequest): boolean
  timeoutMs?: number
}

export class PaneConfirmer {
  private awaiting = new Map<string, (paneId: string | null) => void>()

  constructor(private deps: PaneConfirmerDeps) {}

  confirm(sessionId: string, ccSessionId: string): Promise<string | null> {
    const requestId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.awaiting.delete(requestId)
        resolve(null)
      }, this.deps.timeoutMs ?? PANE_CHECK_TIMEOUT_MS)
      timer.unref?.()
      this.awaiting.set(requestId, (paneId) => {
        clearTimeout(timer)
        resolve(paneId)
      })
      if (!this.deps.request({ requestId, sessionId, ccSessionId })) {
        this.onResult({ requestId, paneId: null })
      }
    })
  }

  onResult(result: PaneCheckResult): void {
    const resolve = this.awaiting.get(result.requestId)
    if (!resolve) return
    this.awaiting.delete(result.requestId)
    resolve(result.paneId)
  }
}
