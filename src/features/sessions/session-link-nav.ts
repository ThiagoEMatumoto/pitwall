import { create } from 'zustand'
import { matchCombo, resolveCombo, type Combo } from '@/lib/keybindings'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { useAttentionStore } from '@/features/session-switcher/useAttentionQueue'
import type { Area } from '@/store/appStore'
import {
  canOpenGraphNode,
  ensureSessionGraph,
  openGraphNode,
  useSessionGraphStore,
} from './session-graph-store'
import { stepLink } from './session-links'
import type { SessionGraph, SessionGraphNode } from '../../../shared/types/session-graph'

export type SessionLinkKeyAction = 'prev' | 'next'

// Campo de texto do app (Composer, rename, busca): Alt/Option+tecla é edição
// nativa ali. O textarea auxiliar do xterm NÃO conta — sem capturar lá, a tecla
// vira ESC+tecla no PTY.
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.classList.contains('xterm-helper-textarea')) return false
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  )
}

// Na área de Design os atalhos são do canvas (Alt+seta é nudge, se o usuário
// remapear pra lá) — mesma regra de ceder a tecla que a fila de atenção segue.
export function sessionLinkKeyAction(
  e: KeyboardEvent,
  overrides: Record<string, Combo>,
  area: Area,
): SessionLinkKeyAction | null {
  if (area === 'design' || isTextEntryTarget(e.target)) return null
  if (matchCombo(e, resolveCombo('session.linkPrev', overrides))) return 'prev'
  if (matchCombo(e, resolveCombo('session.linkNext', overrides))) return 'next'
  return null
}

// Onde o usuário está: a filha aberta no quick look, se houver (o peek cobre a
// aba); senão a aba ativa.
export function currentGraphNode(
  graph: SessionGraph,
  where: { activeCc: string | null; peekId: string | null },
): SessionGraphNode | null {
  const peeked = where.peekId
    ? graph.nodes.find((n) => n.childOfHandoffId === where.peekId)
    : undefined
  if (peeked) return peeked
  return graph.nodes.find((n) => n.ccSessionId === where.activeCc) ?? null
}

export interface SessionLinkFlash {
  nonce: number
  // null = sem relação pra esse lado (ponta da linha ou sessão solta).
  node: SessionGraphNode | null
  position: number
  total: number
}

export const useSessionLinkHudStore = create<{ flash: SessionLinkFlash | null }>(() => ({
  flash: null,
}))

function showFlash(node: SessionGraphNode | null, position = 0, total = 0): void {
  const nonce = (useSessionLinkHudStore.getState().flash?.nonce ?? 0) + 1
  useSessionLinkHudStore.setState({ flash: { nonce, node, position, total } })
}

export function stepSessionLink(delta: 1 | -1): void {
  ensureSessionGraph()
  const { graph } = useSessionGraphStore.getState()
  const current = currentGraphNode(graph, {
    activeCc: useAttentionStore.getState().activeCc,
    peekId: useCrewDockStore.getState().peekId,
  })
  const step = current
    ? stepLink(graph, current.sessionId, delta, (n) => canOpenGraphNode(n))
    : null
  // HUD de "cheguei" só quando abriu de fato.
  if (!step || !openGraphNode(step.node)) {
    showFlash(null)
    return
  }
  showFlash(step.node, step.position, step.total)
}
