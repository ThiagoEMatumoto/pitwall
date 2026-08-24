import { create } from 'zustand'
import { prefsApi } from '@/lib/ipc'

// MESMA chave que gateia o resumo automático no main (voice-summary.ts,
// VOICE_MODE_PREF_KEY) — renderer e main leem a mesma pref.
export const VOICE_MODE_PREF_KEY = 'voice.mode'

interface VoiceModeState {
  enabled: boolean
  loaded: boolean
  load: () => Promise<void>
  setEnabled: (v: boolean) => Promise<void>
}

// Modo voz global (não por sessão): ligado, o fim de cada turno gera resumo no
// main e a sessão ativa fala o resumo. Store compartilhado pra toggle e chip
// enxergarem o mesmo estado sem re-ler a pref.
export const useVoiceModeStore = create<VoiceModeState>((set, get) => ({
  enabled: false,
  loaded: false,

  load: async () => {
    if (get().loaded) return
    const v = await prefsApi.get<boolean>(VOICE_MODE_PREF_KEY)
    set({ enabled: v === true, loaded: true })
  },

  setEnabled: async (v) => {
    set({ enabled: v, loaded: true })
    await prefsApi.set(VOICE_MODE_PREF_KEY, v)
  },
}))
