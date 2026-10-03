import { create } from 'zustand'
import { featureLaneId } from './graph-to-flow'
import { useFeatureMruStore } from './feature-mru-store'

// A feature em foco no mapa: a do cartão selecionado, a do painel da feature
// aberto, ou a última usada. É ela que decide qual mãe o painel mostra.
// focusFeature (o seletor de features usa) também pede ao mapa que enquadre o
// card dela; frameLane só enquadra (o grupo "Sem feature" não tem mãe a seguir).
// O pedido fica aqui até o mapa montado consumi-lo (takeFrame).
interface FrameRequest {
  flowId: string
  featureId: string | null
  nonce: number
}

interface MapFocusState {
  featureId: string | null
  setFeature: (featureId: string) => void
  frame: FrameRequest | null
  focusFeature: (featureId: string) => void
  frameLane: (flowId: string) => void
  takeFrame: () => Omit<FrameRequest, 'nonce'> | null
}

export const useMapFocusStore = create<MapFocusState>((set, get) => ({
  featureId: null,
  // Toda feature posta em foco sobe no MRU do seletor, mesmo já sendo a em foco:
  // depois de um grupo "Sem feature" (que não muda a em foco), voltar a ela pelo
  // cartão precisa contar, senão o toque rápido "voltaria" para onde já se está.
  setFeature: (featureId) => {
    useFeatureMruStore.getState().touch(featureId)
    if (get().featureId !== featureId) set({ featureId })
  },
  frame: null,
  focusFeature: (featureId) => {
    useFeatureMruStore.getState().touch(featureId)
    set((s) => ({
      featureId,
      frame: { flowId: featureLaneId(featureId), featureId, nonce: (s.frame?.nonce ?? 0) + 1 },
    }))
  },
  frameLane: (flowId) =>
    set((s) => ({ frame: { flowId, featureId: null, nonce: (s.frame?.nonce ?? 0) + 1 } })),
  takeFrame: () => {
    const f = get().frame
    if (!f) return null
    set({ frame: null })
    return { flowId: f.flowId, featureId: f.featureId }
  },
}))
