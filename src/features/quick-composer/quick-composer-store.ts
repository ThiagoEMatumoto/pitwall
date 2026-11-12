import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { sendToApi } from '@/lib/ipc'
import {
  useVisibleLiveSessions,
  withCrewSessions,
} from '@/features/session-switcher/useGlobalSessions'
import { useAppStore } from '@/store/appStore'
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

// As visíveis mais as filhas em segundo plano: sem aba elas não estão na barra,
// e mandar um prompt era justamente o que faltava alcançar.
export function useSendTargets(): SendTarget[] {
  const all = useAppStore((s) => s.liveSessions)
  const visible = useVisibleLiveSessions()
  const graph = useSessionGraph()
  return useMemo(
    () => buildTargets(withCrewSessions(all, visible, true).items, graph.nodes),
    [all, visible, graph.nodes],
  )
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
    restored: 0,
    restoredDelivered: 0,
    maybeUndelivered: 0,
    needsConfirmation: 0,
    discardedObsolete: 0,
    awaitingNoticed: 0,
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
