// Decisão do usuário: a mensagem que ELE manda a uma filha fora da tela (processo
// vivo, sem aba) abre a aba dela antes do envio, para ela não seguir trabalhando
// invisível depois de ele falar com ela. Mensagem da mãe não passa por aqui: só
// marca não lida.
import { useAppStore } from '@/store/appStore'
import type { LiveSessionInfo } from '../../../shared/types/ipc'
import { paneShowsLive } from './crew'
import { isLinkedChild } from './end-child'

// A filha vinculada em segundo plano (processo vivo, sem aba), ou null.
export function backgroundChild(sessionId: string | null | undefined): LiveSessionInfo | null {
  if (!sessionId || !isLinkedChild(sessionId)) return null
  const { liveSessions, panes } = useAppStore.getState()
  const live = liveSessions.find((s) => s.id === sessionId && s.status !== 'ended')
  if (!live || panes.some((p) => paneShowsLive(p, live))) return null
  return live
}

// focus: leva o usuário até a aba. Sem focus a aba nasce em segundo plano e ele
// fica onde está (mapa, Room, @alias de outra pane); o card, o quick look e o
// QuickComposer também abrem assim e só navegam depois do envio aceito, para o
// texto e o erro continuarem onde ele digitou.
// Devolve a filha cuja aba abriu, ou null se não havia o que abrir. Só com
// processo vivo: abrir antes de um envio que vai falhar deixaria uma aba morta.
export async function revealChildOnUserMessage(
  sessionId: string | null | undefined,
  opts: { focus: boolean },
): Promise<LiveSessionInfo | null> {
  const live = backgroundChild(sessionId)
  if (!live) return null
  await useAppStore.getState().focusOrOpenSession(live, { background: !opts.focus })
  return live
}
