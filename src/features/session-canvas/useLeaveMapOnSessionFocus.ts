import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store/appStore'
import { useProjectsViewStore } from './projects-view-store'

// O mapa é um overlay sobre o dockview montado: aba focada ou aberta de qualquer
// lugar (sidebar, strip, switcher, toast, nova sessão, CrewPeek) nasceria atrás
// dele, com o xterm recebendo as teclas às cegas. Sair do mapa aqui cobre todos
// os caminhos de uma vez. O Alt+A com o mapa na frente não passa por aqui: ele só
// centraliza o cartão (openAttentionItem não abre a aba).
export function useLeaveMapOnSessionFocus(): void {
  const focusPaneId = useAppStore((s) => s.focusPaneId)
  const paneCount = useAppStore((s) => s.panes.length)
  const restoreComplete = useAppStore((s) => s.restoreComplete)
  const prevCount = useRef(paneCount)

  useEffect(() => {
    // As panes do restore do boot não são um pedido do usuário.
    const grew = restoreComplete && paneCount > prevCount.current
    prevCount.current = paneCount
    if (!focusPaneId && !grew) return
    const view = useProjectsViewStore.getState()
    if (view.view === 'map') view.setView('terminals')
  }, [focusPaneId, paneCount, restoreComplete])
}
