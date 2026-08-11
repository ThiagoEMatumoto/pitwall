import { useEffect, useMemo, useState } from 'react'
import { sessionsApi } from '@/lib/ipc'
import { hiddenCrewSessionIds } from '@/features/handoffs/crew'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import type { LiveSessionInfo } from '../../../shared/types/ipc'

// Sessões vivas "visíveis" pro usuário — fonte ÚNICA da regra, lida pela barra,
// pelos seletores (SessionSwitcher/CommandPalette) e pela Home. Filha de handoff
// só some enquanto está no dock; com pane aberta ela volta a contar como sessão
// normal (senão haveria aba ativa sem chip nem entrada no switcher).
export function useVisibleLiveSessions(): LiveSessionInfo[] {
  const allLiveSessions = useAppStore((s) => s.liveSessions)
  const panes = useAppStore((s) => s.panes)
  const handoffs = useHandoffsStore((s) => s.handoffs)
  return useMemo(() => {
    const open = new Set<string>()
    for (const p of panes) {
      if (p.session.ccSessionId) open.add(p.session.ccSessionId)
    }
    const hidden = hiddenCrewSessionIds(handoffs, allLiveSessions, open)
    return allLiveSessions.filter((s) => !hidden.has(s.id))
  }, [allLiveSessions, panes, handoffs])
}

// Encerradas retomáveis, carregadas sob demanda quando `enabled` liga.
// null = ainda carregando (ou fetch nem disparou).
export function useEndedSessions(enabled: boolean): LiveSessionInfo[] | null {
  const [ended, setEnded] = useState<LiveSessionInfo[] | null>(null)
  useEffect(() => {
    if (!enabled) return
    setEnded(null)
    let cancelled = false
    void sessionsApi.listEndedGlobal().then((list) => {
      if (!cancelled) setEnded(list)
    })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return ended
}
