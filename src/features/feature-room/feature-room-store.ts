import { create } from 'zustand'
import { useAppStore } from '@/store/appStore'

// Os 3 passos de "Iniciar sessão-mãe": worktree (IPC em voo) → terminal (até a
// sessão aparecer em liveSessions) → chat (até o 1º chat:transcript-update dela).
export type PendingMotherStep = 'worktree' | 'terminal' | 'chat'
export interface PendingMother {
  featureId: string
  sessionId: string | null // null enquanto o room:start-mother não voltou
  step: PendingMotherStep
  // O passo travou (morreu depois de viva, ou estourou o prazo): o card mostra o
  // motivo e a saída em vez de "Iniciando…" para sempre.
  failure?: string
}

// A Room aberta: qual feature, o filtro da linha do tempo e o item aberto da fila.
interface FeatureRoomState {
  featureId: string | null
  timelineFilter: string | null // sessionId
  openId: string | null // subjectKey do item aberto
  // Tab de mãe escolhida por feature. A recém-criada entra aqui ANTES de o grafo
  // a enxergar, então o centro já é dela quando ela aparecer.
  selectedMotherId: Record<string, string>
  pendingMother: PendingMother | null
  openRoom: (featureId: string) => void
  setFilter: (sessionId: string | null) => void
  setOpen: (subjectKey: string | null) => void
  selectMother: (featureId: string, sessionId: string) => void
  setPendingMother: (pending: PendingMother | null) => void
}

export const useFeatureRoomStore = create<FeatureRoomState>((set, get) => ({
  featureId: null,
  timelineFilter: null,
  openId: null,
  selectedMotherId: {},
  pendingMother: null,
  openRoom: (featureId) => {
    // Trocar de feature zera filtro e item aberto (eram da outra).
    if (get().featureId !== featureId) set({ featureId, timelineFilter: null, openId: null })
    useAppStore.getState().setArea('room')
  },
  setFilter: (timelineFilter) => set({ timelineFilter }),
  setOpen: (openId) => set({ openId }),
  selectMother: (featureId, sessionId) =>
    set((s) => ({ selectedMotherId: { ...s.selectedMotherId, [featureId]: sessionId } })),
  setPendingMother: (pendingMother) => set({ pendingMother }),
}))
