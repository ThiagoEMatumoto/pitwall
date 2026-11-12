import { create } from 'zustand'
import { gpuApi } from '@/lib/ipc'
import { withGpuDisabled } from '../../../shared/gpu-status'
import type { GpuStatus } from '../../../shared/types/ipc'

interface GpuStatusState {
  status: GpuStatus | null
  load: () => Promise<void>
  setDisabled: (disabled: boolean) => Promise<void>
  setOzone: (ozone: boolean) => Promise<void>
}

// O gpu:status visto pelo renderer. As Configurações e o aviso do rail leem
// daqui: religar por um dos dois tem de aparecer no outro.
export const useGpuStatusStore = create<GpuStatusState>((set, get) => ({
  status: null,

  load: async () => {
    set({ status: await gpuApi.status() })
  },

  setDisabled: async (disabled) => {
    const { status } = get()
    if (!status) return
    set({ status: withGpuDisabled(status, disabled) })
    try {
      await gpuApi.setDisabled(disabled)
    } catch (err) {
      // O main grava três prefs em sequência e pode ter parado no meio: vale o
      // que ficou no banco, não o palpite local.
      console.warn('[gpu] não gravou a preferência de aceleração:', String(err))
      await get().load()
    }
  },

  setOzone: async (ozone) => {
    const { status } = get()
    if (!status) return
    set({ status: { ...status, prefOzone: ozone } })
    await gpuApi.setOzone(ozone)
  },
}))
