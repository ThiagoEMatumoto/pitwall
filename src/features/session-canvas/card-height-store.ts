import { create } from 'zustand'

// Altura DESENHADA de cada cartão aberto (px do fluxo), medida no DOM. O layout
// empilha e ajusta as caixas por ela: com a vaga máxima (OPEN_H) cada cartão
// reservava ~300px e sobrava um vão embaixo de todo cartão de 4 linhas.
interface CardHeightState {
  heights: Readonly<Record<string, number>>
  report: (sessionId: string, height: number) => void
}

// Abaixo disto é ruído de subpixel/re-render: não vale re-layout do mapa.
const MIN_DELTA = 2

export function nextHeights(
  heights: Readonly<Record<string, number>>,
  sessionId: string,
  height: number,
): Readonly<Record<string, number>> {
  const h = Math.round(height)
  if (h <= 0) return heights
  const prev = heights[sessionId]
  if (prev !== undefined && Math.abs(prev - h) < MIN_DELTA) return heights
  return { ...heights, [sessionId]: h }
}

export const useCardHeightStore = create<CardHeightState>((set) => ({
  heights: {},
  report: (sessionId, height) =>
    set((s) => {
      const heights = nextHeights(s.heights, sessionId, height)
      return heights === s.heights ? s : { heights }
    }),
}))
