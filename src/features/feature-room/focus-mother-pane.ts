import { useProjectsViewStore } from '@/features/session-canvas/projects-view-store'
import { useAppStore } from '@/store/appStore'
import type { SessionGraphNode } from '../../../shared/types/session-graph'

// Clicar numa mãe do painel foca a pane REAL dela no dockview; sem pane aberta,
// re-attacha à PTY viva como pane nova (focusOrOpenSession), nunca uma página.
// O resume troca sessions.id e mantém o ccSessionId: casa pelos dois.
// false = a sessão não está entre as vivas (nada a focar).
export function focusMotherPane(
  node: Pick<SessionGraphNode, 'sessionId' | 'ccSessionId'>,
): boolean {
  const { liveSessions, focusOrOpenSession } = useAppStore.getState()
  const live =
    liveSessions.find((s) => s.id === node.sessionId && s.status !== 'ended') ??
    (node.ccSessionId
      ? liveSessions.find((s) => s.ccSessionId === node.ccSessionId && s.status !== 'ended')
      : undefined)
  if (!live) return false
  const view = useProjectsViewStore.getState()
  if (view.view === 'map') view.setView('terminals')
  void focusOrOpenSession(live)
  return true
}
