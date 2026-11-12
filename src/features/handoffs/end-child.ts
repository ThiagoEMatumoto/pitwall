// Encerrar × minimizar para filhas de handoff. Encerrar mata o processo (com a
// janela de Desfazer do endSession) e NÃO desvincula: a filha segue ligada à mãe
// e retomável. Minimizar (closePane) só tira a aba da tela.
import { sessionsApi } from '@/lib/ipc'
import { hasSessionExited, useAppStore } from '@/store/appStore'
import { motherOfChildMap } from '@/features/sessions/conversation-hierarchy'
import { useSessionGraphStore } from '@/features/sessions/session-graph-store'
import type { LiveSessionInfo } from '../../../shared/types/ipc'

// A mesma régua da barra e do switcher: filha pela conversa, até o Desvincular.
export function isLinkedChild(sessionId: string): boolean {
  return motherOfChildMap(useSessionGraphStore.getState().graph.nodes).has(sessionId)
}

export function useIsLinkedChild(sessionId: string | null | undefined): boolean {
  return useSessionGraphStore((s) =>
    sessionId ? motherOfChildMap(s.graph.nodes).has(sessionId) : false,
  )
}

// true = pode encerrar. Só a filha no meio de um turno pede confirmação: matar
// ali perde trabalho em andamento. Parada (idle/waiting) encerra direto — o
// Desfazer do toast cobre o clique errado.
export function confirmEndChild(
  live: Pick<LiveSessionInfo, 'status'> | null,
  isChild: boolean,
  ask: (message: string) => boolean = (message) => window.confirm(message),
): boolean {
  if (!isChild) return true
  if (live?.status !== 'working' && live?.status !== 'starting') return true
  return ask(
    'Esta filha está trabalhando. Encerrar mata o processo agora e o turno em andamento se perde.\n\nEla continua vinculada à mãe e pode ser retomada depois. Encerrar mesmo assim?',
  )
}

// O status do renderer chega pelo stream global, depois do main: no clique logo
// após a filha mudar de estado ele ainda é o anterior, e a pergunta saía trocada.
// Vale o que o main lê na hora; sem resposta dele (ou sem a sessão nela), o do
// renderer.
async function liveNow(sessionId: string): Promise<Pick<LiveSessionInfo, 'status'> | null> {
  const fromMain = await sessionsApi.listLiveGlobal().catch(() => null)
  return (
    fromMain?.find((s) => s.id === sessionId) ??
    useAppStore.getState().liveSessions.find((s) => s.id === sessionId) ??
    null
  )
}

// Filhas com a consulta ao main em voo: o clique repetido não pergunta de novo.
const asking = new Set<string>()

// O Encerrar pedido pelo usuário, de qualquer superfície (cabeçalho, barra,
// canvas, Room, X da aba da filha).
export function endSessionAsked(sessionId: string): void {
  const linkedChild = isLinkedChild(sessionId)
  const end = (): void => useAppStore.getState().endSession(sessionId, { linkedChild })
  // Só a filha pode pedir confirmação: as outras encerram sem esperar o main.
  if (!linkedChild) {
    end()
    return
  }
  if (asking.has(sessionId)) return
  asking.add(sessionId)
  void liveNow(sessionId)
    .then((live) => {
      if (confirmEndChild(live, linkedChild)) end()
    })
    .finally(() => asking.delete(sessionId))
}

// X da aba de uma filha: encerra de verdade. Sem processo (aba dormindo, PTY que
// já saiu) não há o que encerrar: fecha a aba como a de qualquer sessão.
export function closeChildTab(paneId: string): void {
  const { panes, closePane } = useAppStore.getState()
  const pane = panes.find((p) => p.paneId === paneId)
  if (!pane) return
  if (pane.dormant || hasSessionExited(pane.session.id)) {
    closePane(paneId)
    return
  }
  endSessionAsked(pane.session.id)
}
