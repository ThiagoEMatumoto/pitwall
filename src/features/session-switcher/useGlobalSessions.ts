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

// Vivas que só aparecem na equipe (filhas no dock): a Home e o seletor contam as
// DELE, o mapa e o hero contam todas. Sem dizer a diferença, "11 trabalhando" no
// mapa e "9" no seletor pareciam dois números para o mesmo estado.
export function crewOnlyCount(all: LiveSessionInfo[], visible: LiveSessionInfo[]): number {
  const shown = new Set(visible.map((s) => s.id))
  return all.filter((s) => s.status !== 'ended' && !shown.has(s.id)).length
}

// Regra única de contagem: o número é SEMPRE o total (com as filhas da Equipe),
// igual ao mapa e ao hero; "N na equipe" diz quantas delas estão só no dock. O
// "+2" ao lado de "9" lia como soma a fazer, e cada tela mostrava um número.
export function crewOnlyLabel(n: number): string | null {
  return n > 0 ? `${n} na equipe` : null
}

/**
 * A linha do seletor só repete o status quando ele difere do grupo em que está
 * (o 1º status do grupo é o dele): sob "Trabalhando", 11 linhas com "⚡ trabalhando"
 * eram ruído e tiravam peso de projeto, tempo e feature. Grupo sem status
 * (as encerradas/avulsas) mostra sempre.
 */
export function showRowStatus(
  status: LiveSessionInfo['status'],
  groupStatuses: readonly string[],
): boolean {
  return groupStatuses.length === 0 || status !== groupStatuses[0]
}

/** O total que as listas mostram: as visíveis + as que estão só na Equipe. */
export function countWithCrew(listed: number, crewOnly: number, crewListed: boolean): number {
  return crewListed ? listed : listed + crewOnly
}

// As filhas da Equipe entram no seletor com o toggle ligado OU durante uma busca:
// quem digita o nome de uma filha espera achá-la, não um "nada encontrado".
export function listsCrew(toggle: boolean, query: string): boolean {
  return toggle || query.trim().length > 0
}

// O seletor com o toggle "+N na equipe" ligado: as vivas visíveis mais as filhas
// que estão só no dock (marcadas por `crewIds`), na ordem do snapshot.
export function withCrewSessions(
  all: LiveSessionInfo[],
  visible: LiveSessionInfo[],
  includeCrew: boolean,
): { items: LiveSessionInfo[]; crewIds: ReadonlySet<string> } {
  const shown = new Set(visible.map((s) => s.id))
  const crew = all.filter((s) => s.status !== 'ended' && !shown.has(s.id))
  const crewIds = new Set(crew.map((s) => s.id))
  if (!includeCrew || crew.length === 0) return { items: visible, crewIds: new Set() }
  return { items: all.filter((s) => shown.has(s.id) || crewIds.has(s.id)), crewIds }
}

export function useCrewOnlyCount(): number {
  const all = useAppStore((s) => s.liveSessions)
  const visible = useVisibleLiveSessions()
  return crewOnlyCount(all, visible)
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
export function unknownLiveIds(
  allLiveSessions: LiveSessionInfo[],
  graphLive: Iterable<string>,
): string[] {
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

/**
 * Ordem dentro de um grupo do seletor: primeiro as sessões com feature,
 * agrupadas por feature (a feature da sessão mais recente primeiro), com a mãe
 * à frente e as filhas logo abaixo dela; depois as soltas, por recência. Só por
 * recência, a mãe da única feature ativa caía na última linha, abaixo de 8
 * sessões soltas. `childOf` marca as filhas postas sob a mãe (o "↳").
 */
export function orderByFeature<T extends { id: string }>(
  items: T[],
  featureOf: ReadonlyMap<string, string | null>,
  motherOfChild: ReadonlyMap<string, string>,
): { items: T[]; childOf: ReadonlyMap<string, string> } {
  const present = new Set(items.map((s) => s.id))
  const childOf = new Map<string, string>()
  for (const s of items) {
    const mother = motherOfChild.get(s.id)
    if (mother && mother !== s.id && present.has(mother)) childOf.set(s.id, mother)
  }
  const out: T[] = []
  const placed = new Set<string>()
  const place = (s: T) => {
    if (placed.has(s.id)) return
    placed.add(s.id)
    out.push(s)
    for (const c of items) if (childOf.get(c.id) === s.id) place(c)
  }
  const keyOf = (s: T): string | null => {
    const mother = childOf.get(s.id)
    return featureOf.get(s.id) ?? (mother ? (featureOf.get(mother) ?? null) : null)
  }
  const features = [...new Set(items.map(keyOf).filter((f): f is string => !!f))]
  for (const f of features)
    for (const s of items) if (keyOf(s) === f && !childOf.has(s.id)) place(s)
  for (const s of items) if (!childOf.has(s.id) || !placed.has(childOf.get(s.id)!)) place(s)
  return { items: out, childOf }
}
