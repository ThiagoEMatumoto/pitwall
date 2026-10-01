import { useMemo } from 'react'
import { create } from 'zustand'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { useProjectsViewStore } from '@/features/session-canvas/projects-view-store'
import { openSessionByCc } from '@/features/sessions/open-session'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import { useSessionMruStore } from '@/store/session-mru-store'
import {
  buildAttentionQueue,
  planAttentionStep,
  planBackTarget,
  type AttentionItem,
  type StoredAttentionCursor,
} from './attention-queue'
import { useVisibleLiveSessions, visibleLiveSessions } from './useGlobalSessions'

export function useAttentionQueue(): AttentionItem[] {
  const visibleSessions = useVisibleLiveSessions()
  const liveSessions = useAppStore((s) => s.liveSessions)
  const handoffs = useHandoffsStore((s) => s.handoffs)
  return useMemo(
    () => buildAttentionQueue({ visibleSessions, liveSessions, handoffs }),
    [visibleSessions, liveSessions, handoffs],
  )
}

// Leitura pontual (sem assinar): o handler de tecla do AppShell só precisa da fila
// no instante do Alt+A — assinar re-renderizaria o shell a cada lote de atividade.
export function getAttentionQueue(): AttentionItem[] {
  const { liveSessions, panes } = useAppStore.getState()
  const { handoffs } = useHandoffsStore.getState()
  return buildAttentionQueue({
    visibleSessions: visibleLiveSessions(liveSessions, panes, handoffs),
    liveSessions,
    handoffs,
  })
}

// O que o HUD mostra no último pulo. item null = fila vazia ("Nada esperando").
export interface AttentionFlash {
  nonce: number
  position: number
  total: number
  item: AttentionItem | null
}

// Quem abriu por último o popover de uma sessão (fixado pelo Alt+A ou expandido
// na lista da TitleBar): o outro fecha o dele. Dois popovers da mesma sessão
// mandariam duas respostas pro mesmo menu.
export interface AttentionPopoverClaim {
  sessionId: string
  by: 'pinned' | 'list'
}

interface AttentionState {
  // Sessão ativa no dockview (espelhada pelo AppShell, que é quem sabe).
  activeCc: string | null
  cursor: StoredAttentionCursor | null
  flash: AttentionFlash | null
  popoverClaim: AttentionPopoverClaim | null
  setActiveCc: (cc: string | null) => void
}

export const useAttentionStore = create<AttentionState>((set) => ({
  activeCc: null,
  cursor: null,
  flash: null,
  popoverClaim: null,
  setActiveCc: (activeCc) => set({ activeCc }),
}))

export function claimAttentionPopover(sessionId: string | null, by: AttentionPopoverClaim['by']) {
  if (sessionId) useAttentionStore.setState({ popoverClaim: { sessionId, by } })
}

// true quando o OUTRO dono acabou de abrir o popover desta sessão.
export function isClaimedByOther(
  claim: AttentionPopoverClaim | null,
  sessionId: string | null | undefined,
  me: AttentionPopoverClaim['by'],
): boolean {
  return claim != null && claim.by !== me && sessionId != null && claim.sessionId === sessionId
}

function showFlash(position: number, total: number, item: AttentionItem | null): void {
  const nonce = (useAttentionStore.getState().flash?.nonce ?? 0) + 1
  useAttentionStore.setState({ flash: { nonce, position, total, item } })
}

// crew abre o quick look (nenhuma aba nasce — o Crew Dock continua dono da filha);
// session fecha um peek aberto, senão o overlay cobriria a aba recém-focada — sem
// devolver o foco à origem do peek, que reativaria a aba de antes do pulo.
export function openAttentionItem(item: AttentionItem): void {
  const dock = useCrewDockStore.getState()
  if (item.kind === 'crew') {
    if (item.handoffId) dock.openPeek(item.handoffId)
    return
  }
  if (dock.peekTarget) dock.closePeek({ restoreFocus: false })
  // Mapa na frente: o SessionMap só centraliza o cartão (pelo flash). Abrir a aba
  // a focaria atrás do overlay, com o xterm pegando as teclas às cegas.
  if (useAppStore.getState().area === 'projects' && useProjectsViewStore.getState().view === 'map')
    return
  if (item.ccSessionId) openSessionByCc(item.ccSessionId)
}

export function cycleAttention(queue: AttentionItem[], delta: 1 | -1): void {
  const { activeCc, cursor } = useAttentionStore.getState()
  const step = planAttentionStep(queue, cursor, activeCc, delta)
  if (!step) {
    showFlash(0, 0, null)
    return
  }
  const item = queue[step.index]
  openAttentionItem(item)
  useAttentionStore.setState({ cursor: step.cursor })
  showFlash(step.index + 1, queue.length, item)
}

// Alt+Q: volta pra sessão focada antes da atual (alternar como alt-tab).
export function goBackSession(): void {
  const { activeCc } = useAttentionStore.getState()
  const { liveSessions, panes } = useAppStore.getState()
  const { handoffs } = useHandoffsStore.getState()
  const target = planBackTarget(useSessionMruStore.getState().order, activeCc, {
    visibleSessions: visibleLiveSessions(liveSessions, panes, handoffs),
    liveSessions,
    handoffs,
  })
  if (!target) return
  const dock = useCrewDockStore.getState()
  if (target.kind === 'crew') {
    dock.openPeek(target.handoffId)
    return
  }
  if (dock.peekTarget) dock.closePeek({ restoreFocus: false })
  openSessionByCc(target.ccSessionId)
}
