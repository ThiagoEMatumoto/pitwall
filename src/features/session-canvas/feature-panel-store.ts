import { create } from 'zustand'

// Painel lateral da feature sobre o mapa (F4). Aberto pelo header do card da
// feature; não navega — o mapa continua atrás.
interface FeaturePanelState {
  openFeatureId: string | null
  open: (featureId: string) => void
  close: () => void
}

export const useFeaturePanelStore = create<FeaturePanelState>((set) => ({
  openFeatureId: null,
  open: (featureId) => set({ openFeatureId: featureId }),
  close: () => set({ openFeatureId: null }),
}))
