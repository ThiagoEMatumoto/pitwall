import { useMemo } from 'react'
import { crewAttentionCount } from '@/features/handoffs/crew'
import { attentionHandoffIds, humanQueue } from '../../../shared/attention/selectors'
import { useAttentionListStore } from '@/store/attentionStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import { useVisibleLiveSessions } from './useGlobalSessions'

// Sessões aguardando input do usuário entre as VISÍVEIS (mesma regra da barra e
// do switcher). Alimenta os badges da IconRail e do botão do switcher — que
// espelham a barra, então contam exatamente os chips que ela marca. A TitleBar
// não usa este número: o "N no box" dela é a fila do Alt+A (attentionCount),
// que inclui a filha com aba aberta e pergunta pendente mesmo com a PTY trabalhando.
export function useWaitingCount(): number {
  const visible = useVisibleLiveSessions()
  return useMemo(() => visible.filter((s) => s.status === 'waiting').length, [visible])
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
