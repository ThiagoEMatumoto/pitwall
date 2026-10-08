import { create } from 'zustand'
import { useAppStore } from '@/store/appStore'

// A Room aberta: qual feature, o filtro da linha do tempo e o item aberto da fila.
interface FeatureRoomState {
  featureId: string | null
  timelineFilter: string | null // sessionId
  openId: string | null // subjectKey do item aberto
  openRoom: (featureId: string) => void
  setFilter: (sessionId: string | null) => void
  setOpen: (subjectKey: string | null) => void
}

export const useFeatureRoomStore = create<FeatureRoomState>((set, get) => ({
  featureId: null,
  timelineFilter: null,
  openId: null,
  openRoom: (featureId) => {
    // Trocar de feature zera filtro e item aberto (eram da outra).
    if (get().featureId !== featureId) set({ featureId, timelineFilter: null, openId: null })
    useAppStore.getState().setArea('room')
  },
  setFilter: (timelineFilter) => set({ timelineFilter }),
  setOpen: (openId) => set({ openId }),
}))
