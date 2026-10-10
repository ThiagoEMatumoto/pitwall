import { useAppStore } from '@/store/appStore'

// Ativação de aba (dockview onDidActivePanelChange) acorda a pane dormant. É o
// único gatilho fora do botão "Retomar": montagem e visibilidade não contam,
// porque o dockview monta todas as abas (defaultRenderer="always").
export function wakeIfDormant(paneId: string | null | undefined): void {
  if (!paneId) return
  const pane = useAppStore.getState().panes.find((p) => p.paneId === paneId)
  if (pane?.dormant) void useAppStore.getState().wakeDormantPane(paneId)
}
