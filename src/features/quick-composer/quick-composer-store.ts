import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { sendToApi } from '@/lib/ipc'
import { useVisibleLiveSessions } from '@/features/session-switcher/useGlobalSessions'
import { useSessionGraph } from '@/features/sessions/session-graph-store'
import { buildTargets, type SendTarget } from './target-search'
import type { PromptQueueSnapshot } from '../../../shared/types/send-prompt'

interface QuickComposerState {
  open: boolean
  // sessions.id pré-selecionado ao abrir (fim de turno no popover de atenção).
  targetId: string | null
  openFor: (targetId: string | null) => void
  close: () => void
}

export const useQuickComposerStore = create<QuickComposerState>((set) => ({
  open: false,
  targetId: null,
  openFor: (targetId) => set({ open: true, targetId }),
  close: () => set({ open: false, targetId: null }),
}))

export function useSendTargets(): SendTarget[] {
  const live = useVisibleLiveSessions()
  const graph = useSessionGraph()
  return useMemo(() => buildTargets(live, graph.nodes), [live, graph.nodes])
}

const EMPTY_QUEUE: PromptQueueSnapshot = {
  items: [],
  counters: {
    delivered: 0,
    expired: 0,
    sessionGone: 0,
    refusedMenuOpen: 0,
    refusedUnparsed: 0,
    refusedInputDirty: 0,
    wakeFailed: 0,
  },
  lastEvent: null,
}

export function usePromptQueue(): PromptQueueSnapshot {
  const [snapshot, setSnapshot] = useState<PromptQueueSnapshot>(EMPTY_QUEUE)
  useEffect(() => {
    let pushed = false
    const off = sendToApi.onQueueUpdated((s) => {
      pushed = true
      setSnapshot(s)
    })
    void sendToApi.queue().then((s) => {
      if (!pushed) setSnapshot(s)
    })
    return off
  }, [])
  return snapshot
}
