import { useMemo } from 'react'
import { crewAttentionCount } from '@/features/handoffs/crew'
import { attentionHandoffIds, humanQueue } from '../../../shared/attention/selectors'
import { useAttentionListStore } from '@/store/attentionStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import { useVisibleLiveSessions } from './useGlobalSessions'

// Itens da fila única (attention:list) cujas sessões são VISÍVEIS (mesma regra da
// barra e do switcher). Alimenta os badges da IconRail e do botão do switcher —
// fim de turno não conta, como no HUD. A TitleBar não usa este número: o "N no
// box" dela é a fila do Alt+A inteira (attentionCount), que inclui as filhas do dock.
export function useWaitingCount(): number {
  const visible = useVisibleLiveSessions()
  const attention = useAttentionListStore((s) => s.items)
  return useMemo(() => {
    const visibleIds = new Set(visible.map((s) => s.id))
    return humanQueue(attention).filter((i) => i.sessionId != null && visibleIds.has(i.sessionId))
      .length
  }, [visible, attention])
}

// A outra metade da conta: filhas do dock na fila única (attention:list). É o
// badge do Crew Dock e o gatilho do auto-reveal — conta toda a equipe, inclusive
// a filha que ele abriu, porque o card dela continua no dock.
export function useCrewWaitingCount(): number {
  const handoffs = useHandoffsStore((s) => s.handoffs)
  const attention = useAttentionListStore((s) => s.items)
  return useMemo(() => crewAttentionCount(attention, handoffs), [attention, handoffs])
}

// Handoffs com item na fila humana: promove o card no dock e acende o âmbar.
export function useCrewAttentionIds(): ReadonlySet<string> {
  const attention = useAttentionListStore((s) => s.items)
  return useMemo(() => attentionHandoffIds(humanQueue(attention)), [attention])
}
