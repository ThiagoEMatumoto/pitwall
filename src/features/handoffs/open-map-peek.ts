import { useHandoffsStore } from '@/store/handoffsStore'
import { dockCrew } from './crew'
import { useCrewDockStore, type CrewPeekMode } from './crew-dock-store'

// A ÚNICA porta do mapa para a modal (cartão, Enter, duplo clique e a faixa do
// lift): filha do Crew Dock abre o peek do HANDOFF — pergunta pendente e resposta
// por handoffs:send-message, o único caminho que retoma a filha e limpa o
// needs_input —, o resto abre o peek da sessão. Sem isto, o mesmo cartão abria
// duas modais com regras diferentes conforme o caminho.
export function openMapPeek(sessionId: string, mode: CrewPeekMode, siblings: string[]): void {
  const handoff = dockCrew(useHandoffsStore.getState().handoffs).find(
    (h) => h.childSessionId === sessionId,
  )
  const dock = useCrewDockStore.getState()
  if (handoff) dock.openPeek(handoff.id, mode, { origin: 'map', siblings })
  else dock.openSessionPeek(sessionId, mode, { origin: 'map', siblings })
}
