import { useEffect, useMemo, useState } from 'react'
import { sessionsApi } from '@/lib/ipc'
import { hiddenCrewSessionIds, openPaneKeys } from '@/features/handoffs/crew'
import { useAppStore, type ActivePane } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'

// Sessões vivas "visíveis" pro usuário — fonte ÚNICA da regra, lida pela barra,
// pelos seletores (SessionSwitcher/CommandPalette) e pela Home. Filha de handoff
// só some enquanto está no dock; com pane aberta ela volta a contar como sessão
// normal (senão haveria aba ativa sem chip nem entrada no switcher).
export function visibleLiveSessions(
  allLiveSessions: LiveSessionInfo[],
  panes: ActivePane[],
  handoffs: Handoff[],
): LiveSessionInfo[] {
  const hidden = hiddenCrewSessionIds(handoffs, allLiveSessions, openPaneKeys(panes))
  return allLiveSessions.filter((s) => !hidden.has(s.id))
}

export function useVisibleLiveSessions(): LiveSessionInfo[] {
  const allLiveSessions = useAppStore((s) => s.liveSessions)
  const panes = useAppStore((s) => s.panes)
  const handoffs = useHandoffsStore((s) => s.handoffs)
  return useMemo(
    () => visibleLiveSessions(allLiveSessions, panes, handoffs),
    [allLiveSessions, panes, handoffs],
  )
}

// Sessões que o mapa desenha: o MESMO conjunto da área Projetos (as visíveis)
// mais as filhas da crew vivas, que lá moram no dock em vez de virar chip.
// Encerrada não entra.
export function mapSessionIds(
  allLiveSessions: LiveSessionInfo[],
  panes: ActivePane[],
  handoffs: Handoff[],
): Set<string> {
  const ids = new Set(visibleLiveSessions(allLiveSessions, panes, handoffs).map((s) => s.id))
  for (const id of hiddenCrewSessionIds(handoffs, allLiveSessions, new Set())) ids.add(id)
  return ids
}

export function useMapSessionIds(): ReadonlySet<string> {
  const allLiveSessions = useAppStore((s) => s.liveSessions)
  const panes = useAppStore((s) => s.panes)
  const handoffs = useHandoffsStore((s) => s.handoffs)
  return useMemo(
    () => mapSessionIds(allLiveSessions, panes, handoffs),
    [allLiveSessions, panes, handoffs],
  )
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
