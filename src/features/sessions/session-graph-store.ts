import { useEffect } from 'react'
import { create } from 'zustand'
import { sessionGraphApi } from '@/lib/ipc'
import { dockCrew } from '@/features/handoffs/crew'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import { openSessionByCc } from './open-session'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'
import type { SessionGraph, SessionGraphNode } from '../../../shared/types/session-graph'

const EMPTY_GRAPH: SessionGraph = { nodes: [], lanes: [], edges: [] }

interface SessionGraphState {
  graph: SessionGraph
}

export const useSessionGraphStore = create<SessionGraphState>(() => ({ graph: EMPTY_GRAPH }))

// Uma assinatura só pro app inteiro: cada pane monta chips, mas o grafo é um.
let started = false
export function ensureSessionGraph(): void {
  if (started) return
  started = true
  let pushed = false
  sessionGraphApi.onUpdated((graph) => {
    pushed = true
    useSessionGraphStore.setState({ graph })
  })
  // A carga inicial não pode sobrescrever um push que chegou antes dela.
  void sessionGraphApi
    .get()
    .then((graph) => {
      if (!pushed) useSessionGraphStore.setState({ graph })
    })
    .catch((err) => console.error('[session-graph] carga inicial falhou:', err))
}

export function useSessionGraph(): SessionGraph {
  useEffect(ensureSessionGraph, [])
  return useSessionGraphStore((s) => s.graph)
}

export interface OpenContext {
  handoffs: Handoff[]
  liveSessions: LiveSessionInfo[]
}

function currentOpenContext(): OpenContext {
  return {
    handoffs: useHandoffsStore.getState().handoffs,
    liveSessions: useAppStore.getState().liveSessions,
  }
}

function peekHandoffId(node: SessionGraphNode, ctx: OpenContext): string | null {
  const handoffId = node.childOfHandoffId
  return handoffId && dockCrew(ctx.handoffs).some((h) => h.id === handoffId) ? handoffId : null
}

// A MESMA regra decide o que o Alt+,/Alt+. considera destino, o que o chip/menu deixa
// clicar e o que openGraphNode abre — senão o passo "anda" pra um nó que não abre
// e o próximo Alt+. recomeça do mesmo lugar.
export function canOpenGraphNode(
  node: SessionGraphNode,
  ctx: OpenContext = currentOpenContext(),
): boolean {
  if (peekHandoffId(node, ctx)) return true
  if (!node.ccSessionId || node.status === 'ended') return false
  return ctx.liveSessions.some((s) => s.ccSessionId === node.ccSessionId)
}

// Filha que o Crew Dock mostra abre no quick look (o dock segue dono dela, nenhuma
// aba nasce); o resto foca/abre a aba — fechando um peek aberto, que cobriria a
// aba recém-focada. false = nada a abrir (e nada fechado).
export function openGraphNode(node: SessionGraphNode): boolean {
  const ctx = currentOpenContext()
  if (!canOpenGraphNode(node, ctx)) return false
  const dock = useCrewDockStore.getState()
  const handoffId = peekHandoffId(node, ctx)
  if (handoffId) {
    dock.openPeek(handoffId)
    return true
  }
  if (dock.peekId) dock.closePeek({ restoreFocus: false })
  return openSessionByCc(node.ccSessionId!)
}
