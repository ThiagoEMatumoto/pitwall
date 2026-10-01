import { useEffect, useMemo, useRef, useState } from 'react'
import { sessionsApi } from '@/lib/ipc'
import { hiddenCrewSessionIds, openPaneKeys } from '@/features/handoffs/crew'
import { pendingEndSessionIds, useAppStore, type ActivePane } from '@/store/appStore'
import { useSessionGraph } from '@/features/sessions/session-graph-store'
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

// Sessões que o mapa desenha: TODA sessão com PTY viva — com aba, sem aba
// (spawn por API/MCP) ou filha no dock. Duas fontes porque o snapshot do store
// só entra em refetch nas mutações do próprio renderer: uma sessão subida pelo
// main (MCP, cenário, outra janela) só aparece nele no próximo refetch, mas o
// grafo do main já a traz viva (status != ended = PTY viva). Encerrada não
// entra, nem a que está na janela de undo do Encerrar.
export function mapSessionIds(
  allLiveSessions: LiveSessionInfo[],
  graphLive: Iterable<string> = [],
  pendingEnd: ReadonlySet<string> = new Set(),
): Set<string> {
  const ids = new Set([...allLiveSessions.map((s) => s.id), ...graphLive])
  for (const id of pendingEnd) ids.delete(id)
  return ids
}

// O cartão desenha pelo grafo, mas composer, terminal e status leem o snapshot:
// sem ele a sessão aparece como "sem PTY viva" e o Terminal não abre.
export function unknownLiveIds(allLiveSessions: LiveSessionInfo[], graphLive: Iterable<string>): string[] {
  const known = new Set(allLiveSessions.map((s) => s.id))
  return [...new Set(graphLive)].filter((id) => !known.has(id)).sort()
}

export function useMapSessionIds(): ReadonlySet<string> {
  const allLiveSessions = useAppStore((s) => s.liveSessions)
  const graph = useSessionGraph()
  const graphLive = useMemo(
    () => graph.nodes.filter((n) => n.status !== 'ended').map((n) => n.sessionId),
    [graph],
  )
  // Refaz o snapshot uma vez por conjunto desconhecido (sem loop se o main
  // ainda não a listar).
  const fetchedFor = useRef('')
  useEffect(() => {
    const pending = pendingEndSessionIds()
    const missing = unknownLiveIds(allLiveSessions, graphLive).filter((id) => !pending.has(id))
    const key = missing.join(',')
    if (!key || key === fetchedFor.current) return
    fetchedFor.current = key
    void useAppStore.getState().refreshLiveSessions()
  }, [allLiveSessions, graphLive])
  return useMemo(
    () => mapSessionIds(allLiveSessions, graphLive, pendingEndSessionIds()),
    [allLiveSessions, graphLive],
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
