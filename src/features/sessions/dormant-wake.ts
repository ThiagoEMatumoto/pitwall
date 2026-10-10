import { useAppStore } from '@/store/appStore'

// Ativação de aba (dockview onDidActivePanelChange) acorda a pane dormant. É o
// único gatilho fora do botão "Retomar": montagem e visibilidade não contam,
// porque o dockview monta todas as abas (defaultRenderer="always").
export function wakeIfDormant(paneId: string | null | undefined): void {
  if (!paneId) return
  const pane = useAppStore.getState().panes.find((p) => p.paneId === paneId)
  if (pane?.dormant) void useAppStore.getState().wakeDormantPane(paneId)
}

// Tempo que a aba precisa ficar ativa para contar como escolha do usuário:
// Ctrl+Tab passando por várias abas dormindo não acorda nenhuma das do meio.
export const WAKE_DWELL_MS = 350

export interface ActivationWaker {
  // onDidActivePanelChange. null cancela o wake pendente sem armar outro.
  activated: (paneId: string | null) => void
  // onDidRemovePanel / onDidMovePanel. O dockview reativa uma aba no mesmo tick
  // da remoção (depois do evento) e do move (antes do evento); nenhuma das duas
  // é o usuário escolhendo acordar.
  panelRemovedOrMoved: () => void
  dispose: () => void
}

export function createActivationWaker(
  isStillActive: (paneId: string) => boolean,
  wake: (paneId: string) => void = wakeIfDormant,
  dwellMs = WAKE_DWELL_MS,
): ActivationWaker {
  let timer: ReturnType<typeof setTimeout> | null = null
  let suppressed = false
  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    activated: (paneId) => {
      cancel()
      if (!paneId || suppressed) return
      timer = setTimeout(() => {
        timer = null
        if (isStillActive(paneId)) wake(paneId)
      }, dwellMs)
    },
    panelRemovedOrMoved: () => {
      cancel()
      if (suppressed) return
      suppressed = true
      queueMicrotask(() => {
        suppressed = false
      })
    },
    dispose: cancel,
  }
}
