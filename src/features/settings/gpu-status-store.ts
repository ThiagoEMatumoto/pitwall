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

// Com o status desconhecido o aviso do rail pede de novo neste intervalo.
export const GPU_STATUS_RETRY_MS = 5_000

// Um gpu:status pedido antes de uma escrita responde com as prefs antigas e pode
// chegar depois do estado otimista: a contagem de escritas deixa descartá-lo. O
// descarte pede de novo, porque a resposta jogada fora pode ser a reconciliação
// de uma escrita que falhou, e sem ela o palpite ficaria valendo.
let writes = 0

// O gpu:status visto pelo renderer. As Configurações e o aviso do rail leem
// daqui: religar por um dos dois tem de aparecer no outro.
export const useGpuStatusStore = create<GpuStatusState>((set, get) => ({
  status: null,

  load: async () => {
    const writesAtRequest = writes
    const status = await gpuApi.status()
    if (writes !== writesAtRequest) return get().load()
    set({ status })
  },

  setDisabled: async (disabled) => {
    const { status } = get()
    if (!status) return
    writes += 1
    set({ status: withGpuDisabled(status, disabled) })
    try {
      await gpuApi.setDisabled(disabled)
    } catch (err) {
      // O main grava três prefs em sequência e pode ter parado no meio: vale o
      // que ficou no banco, não o palpite local.
      console.warn('[gpu] não gravou a preferência de aceleração:', String(err))
      await reconcile()
    }
  },

  setOzone: async (ozone) => {
    const { status } = get()
    if (!status) return
    writes += 1
    set({ status: { ...status, prefOzone: ozone } })
    try {
      await gpuApi.setOzone(ozone)
    } catch (err) {
      console.warn('[gpu] não gravou a preferência de Wayland:', String(err))
      await reconcile()
    }
  },
}))

// Depois de uma escrita que falhou vale o que o main responder, nunca o palpite.
// Se nem o gpu:status responde, o estado é desconhecido: null trava os toggles
// até o próximo load.
async function reconcile(): Promise<void> {
  try {
    await useGpuStatusStore.getState().load()
  } catch (err) {
    console.warn('[gpu] não leu o status depois da escrita que falhou:', String(err))
    useGpuStatusStore.setState({ status: null })
  }
}
