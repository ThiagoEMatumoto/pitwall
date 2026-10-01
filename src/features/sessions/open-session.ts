import { useAppStore } from '@/store/appStore'

// Abre/foca a sessão viva pelo ccSessionId. getState() em vez de hook: chamado de
// handlers (toast, notificação nativa, fila de atenção), e a busca é pontual.
// Retorna false quando a sessão não está entre as vivas (nada a abrir).
export function openSessionByCc(ccSessionId: string): boolean {
  const { liveSessions, focusOrOpenSession } = useAppStore.getState()
  const item = liveSessions.find((s) => s.ccSessionId === ccSessionId)
  if (!item) return false
  void focusOrOpenSession(item)
  return true
}
