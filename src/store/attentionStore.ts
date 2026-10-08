import { create } from 'zustand'
import { attentionApi } from '@/lib/ipc'
import type { AttentionItem } from '../../shared/types/attention'

// A fila única do main (attention:list). O payload de attention:changed substitui
// a lista inteira: nada aqui recalcula regra de atenção.
interface AttentionListState {
  items: AttentionItem[]
  load: () => Promise<void>
}

// Assinatura única de attention:changed (StrictMode-safe), como no handoffsStore.
let subscribed = false

export const useAttentionListStore = create<AttentionListState>((set) => ({
  items: [],
  load: async () => {
    if (!subscribed) {
      subscribed = true
      attentionApi.onChanged((items) => set({ items }))
    }
    set({ items: await attentionApi.list() })
  },
}))
