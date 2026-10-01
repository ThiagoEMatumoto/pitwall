import { create } from 'zustand'
import { canvasApi } from '@/lib/ipc'
import type { CanvasCardView, CanvasScope } from '../../../shared/types/canvas'
import type { ScreenTailUpdate } from '../../../shared/types/send-prompt'
import {
  collapseAll,
  enterTerminal,
  hydrateViews,
  inheritViews,
  leaveTerminal,
  openAll,
  toggleCollapsed,
  type ViewChange,
  type ViewMap,
} from './card-view'

export interface CardSize {
  w: number
  h: number
}

// Estado de exibição dos cartões do escopo aberto. O banco é lido UMA vez por
// escopo: depois disso o local é a verdade (as gravações não emitem evento, e um
// reload no meio de uma gravação traria o valor de antes).
interface CardViewStoreState {
  scope: CanvasScope | null
  views: ViewMap
  // Tamanho do cartão em modo terminal (NodeResizer). Da sessão de uso, não do banco.
  terminalSizes: Readonly<Record<string, CardSize>>
  tails: Readonly<Record<string, ScreenTailUpdate>>
  hydrate: (scope: CanvasScope, rows: CanvasCardView[]) => void
  toggle: (sessionId: string) => void
  inherit: (lineage: Array<[string, string]>) => void
  openAll: (ids: string[]) => void
  collapseAll: (ids: string[]) => void
  enterTerminal: (sessionId: string) => void
  leaveTerminal: (sessionId: string) => void
  setTerminalSize: (sessionId: string, size: CardSize) => void
  setTail: (update: ScreenTailUpdate) => void
}

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
    terminalSizes: {},
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
    enterTerminal: (id) => commit(enterTerminal(get().views, id)),
    leaveTerminal: (id) => commit(leaveTerminal(get().views, id)),
    setTerminalSize: (id, size) =>
      set((s) => ({ terminalSizes: { ...s.terminalSizes, [id]: size } })),
    setTail: (update) => set((s) => ({ tails: { ...s.tails, [update.sessionId]: update } })),
  }
})
