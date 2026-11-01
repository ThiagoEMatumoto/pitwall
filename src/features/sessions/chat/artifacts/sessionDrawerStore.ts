import { create } from 'zustand'
import { artifactRefKey, type ArtifactRef } from './artifact-refs'

// Gaveta "Sessão" dos editores: qual artefato está com ela aberta e a largura.
// O botão (toolbar) e o dock (coluna ao lado do canvas) moram em pontos
// diferentes da árvore; o store liga os dois.

export const DRAWER_MIN_WIDTH = 320
export const DRAWER_DEFAULT_WIDTH = 420
// O canvas nunca fica mais estreito que isto por causa da gaveta.
export const DRAWER_CANVAS_MIN_WIDTH = 360

interface SessionDrawerState {
  openKey: string | null
  width: number
  toggle: (ref: ArtifactRef) => void
  close: () => void
  setWidth: (w: number) => void
}

export const useSessionDrawerStore = create<SessionDrawerState>((set) => ({
  openKey: null,
  width: DRAWER_DEFAULT_WIDTH,
  toggle: (ref) =>
    set((s) => {
      const key = artifactRefKey(ref)
      return { openKey: s.openKey === key ? null : key }
    }),
  close: () => set({ openKey: null }),
  setWidth: (w) => set({ width: Math.max(DRAWER_MIN_WIDTH, Math.round(w)) }),
}))
