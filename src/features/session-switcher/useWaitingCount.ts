import { useMemo } from 'react'
import { crewAttentionCount } from '@/features/handoffs/crew'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import { useVisibleLiveSessions } from './useGlobalSessions'

// Sessões aguardando input do usuário entre as VISÍVEIS (mesma regra da barra e
// do switcher: filha de handoff só conta aqui depois que ele abre o terminal
// dela). Alimenta os badges da IconRail e do botão do switcher — que espelham a
// barra, então contam exatamente o que ela mostra.
export function useWaitingCount(): number {
  const visible = useVisibleLiveSessions()
  return useMemo(() => visible.filter((s) => s.status === 'waiting').length, [visible])
}

// A outra metade da conta: filhas de handoff esperando você (status vivo
// 'waiting' OU needs_input). É o badge do Crew Dock e o gatilho do auto-reveal —
// conta toda a equipe, inclusive a filha que ele abriu, porque o card dela
// continua no dock.
export function useCrewWaitingCount(): number {
  const liveSessions = useAppStore((s) => s.liveSessions)
  const handoffs = useHandoffsStore((s) => s.handoffs)
  return useMemo(
    () => crewAttentionCount(handoffs, liveSessions),
    [liveSessions, handoffs],
  )
}
