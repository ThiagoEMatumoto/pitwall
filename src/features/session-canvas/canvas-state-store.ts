import { useEffect } from 'react'
import { create } from 'zustand'
import { canvasApi } from '@/lib/ipc'
import type {
  CanvasCardSize,
  CanvasPosition,
  CanvasPositionInput,
  CanvasScope,
  CanvasState,
} from '../../../shared/types/canvas'

// O upsert do main grava w/h junto com x/y: um arrasto (que só manda x/y) zerava
// o tamanho que o usuário deu ao cartão. Sem w/h no item = mantém o salvo; null
// explícito = volta ao padrão.
export function withKeptSizes(
  items: CanvasPositionInput[],
  saved: readonly CanvasPosition[],
  sizes: readonly CanvasCardSize[] = [],
): CanvasPositionInput[] {
  const byKey = new Map<string, { w: number | null; h: number | null }>(
    sizes.map((s) => [`session:${s.sessionId}`, s]),
  )
  for (const p of saved) byKey.set(`${p.kind}:${p.entityId}`, p)
  return items.map((i) => {
    if (i.w !== undefined || i.h !== undefined) return i
    const prev = byKey.get(`${i.kind}:${i.entityId}`)
    return prev && prev.w != null && prev.h != null ? { ...i, w: prev.w, h: prev.h } : i
  })
}

// Estado do canvas (posições/notas/grupos) do escopo aberto no mapa. Um escopo
// por vez: o mapa só mostra um. 'canvas:updated' recarrega; posições não emitem
// (quem arrastou aplica local e grava — setPositions abaixo).
interface CanvasStoreState {
  canvas: CanvasState | null
  load: (scope: CanvasScope) => Promise<void>
  savePositions: (scope: CanvasScope, items: CanvasPositionInput[]) => Promise<void>
}

// Um get iniciado antes de uma gravação otimista volta com o estado anterior a
// ela (ex.: Organizar = clear com broadcast + set sem): aplicá-lo apagaria o que
// acabou de ser gravado. Busca de novo — o get novo entra na fila depois do set.
let writes = 0
const MAX_LOAD_TRIES = 3

export const useCanvasStateStore = create<CanvasStoreState>((set, get) => ({
  canvas: null,
  load: async (scope) => {
    for (let tries = 1; ; tries++) {
      const seen = writes
      const canvas = await canvasApi.get({ scope })
      if (seen === writes || tries >= MAX_LOAD_TRIES) {
        set({ canvas })
        return
      }
    }
  },
  savePositions: async (scope, raw) => {
    writes++
    const current = get().canvas
    const items =
      current?.scope === scope ? withKeptSizes(raw, current.positions, current.sizes) : raw
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
