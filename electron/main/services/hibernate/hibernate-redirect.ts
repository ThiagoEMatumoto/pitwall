// Mensagem que entrou na fila entre a entrega do /exit da hibernação e a saída do
// claude (agent_ask, wake da mãe): sem isto o exit a finalizava como
// session-gone. A conversa não acabou, só dormiu: acorda a pane dormant pelo
// mesmo wake do agent-bus/send-prompt e os itens seguem na sessão nova.
import type { DormantPanes } from '../dormant-panes'

export interface HibernateRedirectDeps {
  wasHibernatedExit(sessionId: string): boolean
  panes(): DormantPanes | null
  ccOf(sessionId: string): string | null
  wakeFailed(sessionId: string, error: string): void
}

export function hibernateExitRedirect(
  deps: HibernateRedirectDeps,
): (sessionId: string) => Promise<string | null> | null {
  return (sessionId) => {
    if (!deps.wasHibernatedExit(sessionId)) return null
    return wake(sessionId, deps)
  }
}

async function wake(sessionId: string, deps: HibernateRedirectDeps): Promise<string | null> {
  // Os ouvintes do exit rodam no mesmo emit: depois deste tick o hibernador já
  // registrou a dormant, qualquer que seja a ordem de registro dos ouvintes.
  await Promise.resolve()
  const panes = deps.panes()
  const cc = deps.ccOf(sessionId)
  if (!panes || !cc || !panes.findDormantByCc(cc)) {
    deps.wakeFailed(sessionId, 'no-dormant-pane')
    return null
  }
  const woke = await panes.wakeDormant(cc, 'send-prompt')
  if (!woke.ok) {
    deps.wakeFailed(sessionId, woke.error)
    return null
  }
  return woke.sessionId
}
