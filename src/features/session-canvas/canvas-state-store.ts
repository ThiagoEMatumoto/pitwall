import { useEffect } from 'react'
import { create } from 'zustand'
import { canvasApi } from '@/lib/ipc'
import type { CanvasPositionInput, CanvasScope, CanvasState } from '../../../shared/types/canvas'

// Estado do canvas (posições/notas/grupos) do escopo aberto no mapa. Um escopo
// por vez: o mapa só mostra um. 'canvas:updated' recarrega; posições não emitem
// (quem arrastou aplica local e grava — setPositions abaixo).
interface CanvasStoreState {
  canvas: CanvasState | null
  load: (scope: CanvasScope) => Promise<void>
  savePositions: (scope: CanvasScope, items: CanvasPositionInput[]) => Promise<void>
}

export const useCanvasStateStore = create<CanvasStoreState>((set, get) => ({
  canvas: null,
  load: async (scope) => {
    const canvas = await canvasApi.get({ scope })
    set({ canvas })
  },
  savePositions: async (scope, items) => {
    const current = get().canvas
    if (current?.scope === scope) {
      const touched = new Set(items.map((i) => `${i.kind}:${i.entityId}`))
      set({
        canvas: {
          ...current,
          positions: [
            ...current.positions.filter((p) => !touched.has(`${p.kind}:${p.entityId}`)),
            ...items.map((i) => ({ ...i, scope, w: i.w ?? null, h: i.h ?? null })),
          ],
        },
      })
    }
    await canvasApi.setPositions({ scope, items })
  },
}))

export function useCanvasState(scope: CanvasScope): CanvasState | null {
  const canvas = useCanvasStateStore((s) => s.canvas)
  const load = useCanvasStateStore((s) => s.load)
  useEffect(() => {
    const reload = () =>
      load(scope).catch((err) => console.error('[session-canvas] falha ao carregar o canvas:', err))
    void reload()
    return canvasApi.onUpdated((e) => {
      if (e.scope === null || e.scope === scope || e.scope === 'all') void reload()
    })
  }, [scope, load])
  return canvas?.scope === scope ? canvas : null
}
