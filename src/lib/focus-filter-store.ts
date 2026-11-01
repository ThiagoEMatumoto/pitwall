import { create } from 'zustand'
import { prefsApi } from '@/lib/ipc'

const KEY = 'sessions.mothersAndAttentionOnly'

interface FocusFilterState {
  // "Mães + quem precisa de mim": barra e seletor escondem filhas que não pedem
  // nada. Padrão LIGADO — com 15-20 sessões (5 mães × 3 filhas) a barra plana
  // virava ruído. Persistido em app_prefs.
  enabled: boolean
  loaded: boolean
  load: () => Promise<void>
  setEnabled: (v: boolean) => Promise<void>
}

export const useFocusFilterStore = create<FocusFilterState>((set, get) => ({
  enabled: true,
  loaded: false,
  load: async () => {
    if (get().loaded) return
    const stored = await prefsApi.get<boolean>(KEY)
    set({ enabled: stored !== false, loaded: true })
  },
  setEnabled: async (v) => {
    set({ enabled: v })
    await prefsApi.set(KEY, v)
  },
}))
