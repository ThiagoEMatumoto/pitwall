import { create } from 'zustand'
import { canvasApi } from '@/lib/ipc'
import type { CanvasCardView, CanvasScope } from '../../../shared/types/canvas'
import type { ScreenTailUpdate } from '../../../shared/types/send-prompt'
import {
  collapseAll,
  hydrateViews,
  inheritViews,
  openAll,
  toggleCollapsed,
  type ViewChange,
  type ViewMap,
} from './card-view'

// Estado de exibição dos cartões do escopo aberto. O banco é lido UMA vez por
// escopo: depois disso o local é a verdade (as gravações não emitem evento, e um
// reload no meio de uma gravação traria o valor de antes).
interface CardViewStoreState {
  scope: CanvasScope | null
  views: ViewMap
  tails: Readonly<Record<string, ScreenTailUpdate>>
  hydrate: (scope: CanvasScope, rows: CanvasCardView[]) => void
  toggle: (sessionId: string) => void
  inherit: (lineage: Array<[string, string]>) => void
  openAll: (ids: string[]) => void
  collapseAll: (ids: string[]) => void
  setTail: (update: ScreenTailUpdate) => void
  // Sessão criada com o mapa na frente: abre na modal de terminal assim que
  // existir (PTY viva + nó no grafo). Quem consome é o SessionMap.
  pendingTerminal: string | null
  requestTerminal: (sessionId: string) => void
  clearPendingTerminal: () => void
}

// Sessão que não chega ao mapa (escopo de outro projeto, spawn que morreu) não
// pode segurar o pedido e abrir a modal minutos depois, do nada.
const PENDING_TERMINAL_TTL_MS = 20_000

export const useCardViewStore = create<CardViewStoreState>((set, get) => {
  const commit = (change: ViewChange) => {
    const { scope } = get()
    if (change.changed.length === 0 || !scope) return
    set({ views: change.next })
    canvasApi
      .setViewStates({ scope, items: change.changed })
      .catch((err) => console.error('[session-canvas] falha ao gravar o estado do cartão:', err))
  }
  return {
    scope: null,
    views: {},
    tails: {},
    hydrate: (scope, rows) => {
      if (get().scope === scope) return
      const change = hydrateViews(rows)
      set({ scope, views: change.next })
      commit(change)
    },
    toggle: (id) => commit(toggleCollapsed(get().views, id)),
    inherit: (lineage) => commit(inheritViews(get().views, lineage)),
    openAll: (ids) => commit(openAll(get().views, ids)),
    collapseAll: (ids) => commit(collapseAll(get().views, ids)),
    setTail: (update) => set((s) => ({ tails: { ...s.tails, [update.sessionId]: update } })),
    pendingTerminal: null,
    requestTerminal: (sessionId) => {
      set({ pendingTerminal: sessionId })
      setTimeout(() => {
        if (get().pendingTerminal === sessionId) set({ pendingTerminal: null })
      }, PENDING_TERMINAL_TTL_MS)
    },
    clearPendingTerminal: () => set({ pendingTerminal: null }),
  }
})
