import { useMemo } from 'react'
import { crewAttentionCount } from '@/features/handoffs/crew'
import { useAppStore } from '@/store/appStore'
import { childSessionIds, useHandoffsStore } from '@/store/handoffsStore'

// Sessões aguardando input do usuário, excluindo filhas de handoff (mesma regra
// do switcher/strip: elas vivem no Crew Dock). Alimenta os badges da IconRail e
// do botão do switcher — que espelham a strip, então não podem contar filhas.
export function useWaitingCount(): number {
  const liveSessions = useAppStore((s) => s.liveSessions)
  const handoffs = useHandoffsStore((s) => s.handoffs)
  return useMemo(() => {
    const childIds = childSessionIds(handoffs)
    return liveSessions.filter((s) => s.status === 'waiting' && !childIds.has(s.id)).length
  }, [liveSessions, handoffs])
}

// A outra metade da conta: filhas de handoff esperando você (status vivo
// 'waiting' OU needs_input). É o badge do Crew Dock e o gatilho do auto-reveal —
// elas ficam fora do useWaitingCount justamente porque não estão na strip.
export function useCrewWaitingCount(): number {
  const liveSessions = useAppStore((s) => s.liveSessions)
  const handoffs = useHandoffsStore((s) => s.handoffs)
  return useMemo(
    () => crewAttentionCount(handoffs, liveSessions),
    [liveSessions, handoffs],
  )
}
