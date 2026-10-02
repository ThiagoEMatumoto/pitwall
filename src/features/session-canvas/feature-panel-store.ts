import { create } from 'zustand'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'

// Painel lateral da feature sobre o mapa (F4). Aberto pelo header do card da
// feature; não navega — o mapa continua atrás.
// Um painel à direita por vez: abrir este recolhe a Equipe para a trilha, e
// expandir a Equipe fecha este. Os dois juntos espremiam o mapa numa faixa.
export type FeaturePanelTab = 'state' | 'notes' | 'decisions' | 'sessions'

interface FeaturePanelState {
  openFeatureId: string | null
  // Aba pedida na abertura (o "+N regras" do card abre direto em Notas & regras).
  tab: FeaturePanelTab
  open: (featureId: string, tab?: FeaturePanelTab) => void
  setTab: (tab: FeaturePanelTab) => void
  close: () => void
}

export const useFeaturePanelStore = create<FeaturePanelState>((set) => ({
  openFeatureId: null,
  tab: 'state',
  open: (featureId, tab = 'state') => {
    const dock = useCrewDockStore.getState()
    if (!dock.collapsed) dock.collapse()
    set({ openFeatureId: featureId, tab })
  },
  setTab: (tab) => set({ tab }),
  close: () => set({ openFeatureId: null }),
}))

useCrewDockStore.subscribe((s, prev) => {
  if (prev.collapsed && !s.collapsed && useFeaturePanelStore.getState().openFeatureId) {
    useFeaturePanelStore.getState().close()
  }
})
