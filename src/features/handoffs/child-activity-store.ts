// Decisão do usuário: mensagem da MÃE para uma filha em segundo plano (processo
// vivo, sem aba) não abre nada nem rouba o foco. Marca a filha como não lida e
// avisa com um "Abrir". Em memória, por sessions.id: a marca só existe enquanto
// ela seguir vinculada, viva e sem aba.
import { create } from 'zustand'
import { sessionGraphApi } from '@/lib/ipc'
import { showToast } from '@/features/notifications/toast-store'
import { liveSessionLabel } from '@/features/session-switcher/session-label'
import { motherOfChildMap } from '@/features/sessions/conversation-hierarchy'
import { useSessionGraphStore } from '@/features/sessions/session-graph-store'
import { useAppStore } from '@/store/appStore'
import type { LiveSessionInfo } from '../../../shared/types/ipc'
import type {
  SessionLinkPulse,
  SessionLinkPulseKind,
} from '../../../shared/types/session-link-pulse'
import { backgroundChild } from './reveal-child'

// 'message': a mãe escreveu para ela (pulso do fio). 'activity': voltou a trabalhar
// sem pulso que explique — mãe Codex não tem SendMessage, e o da mãe Claude só é
// visto na releitura do transcript, que pode chegar depois de a filha já ter reagido.
export type ChildUnread = 'message' | 'activity'

// O pulso prova que a mãe chamou, não que a filha recebeu: o texto não promete entrega.
export const CHILD_UNREAD_HINT: Record<ChildUnread, string> = {
  message: 'a mãe mandou mensagem e você ainda não abriu a aba',
  activity: 'voltou a trabalhar sem aba aberta',
}

interface ChildActivityState {
  unread: Readonly<Record<string, ChildUnread | undefined>>
}

export const useChildActivityStore = create<ChildActivityState>(() => ({ unread: {} }))

// Despacho ('task') é o nascimento da filha e a nota do bastão ('note') é do app:
// nenhum dos dois é a mãe falando com ela.
const MESSAGE_KINDS: ReadonlySet<SessionLinkPulseKind> = new Set(['message', 'answer'])

function motherOf(sessionId: string): string | undefined {
  return motherOfChildMap(useSessionGraphStore.getState().graph.nodes).get(sessionId)
}

function openChild(sessionId: string): void {
  const { liveSessions, focusOrOpenSession } = useAppStore.getState()
  const live = liveSessions.find((s) => s.id === sessionId && s.status !== 'ended')
  if (live) void focusOrOpenSession(live)
}

// Só a mãe DELA: a filha que também lidera recebe o acordar das netas pelo mesmo
// fio, e avisar a cada um desses seria ruído que ninguém pediu.
function receiveLinkPulse(pulse: SessionLinkPulse): void {
  if (pulse.by === 'human' || !MESSAGE_KINDS.has(pulse.kind)) return
  if (motherOf(pulse.toSessionId) !== pulse.fromSessionId) return
  const child = backgroundChild(pulse.toSessionId)
  if (!child) return
  const { unread } = useChildActivityStore.getState()
  // Já avisado: a mãe mandando várias seguidas não empilha avisos.
  if (unread[child.id] === 'message') return
  useChildActivityStore.setState({ unread: { ...unread, [child.id]: 'message' } })
  showToast({
    title: `${liveSessionLabel(child)} recebeu mensagem da mãe`,
    body: 'Segue em 2º plano, sem aba aberta.',
    actionLabel: 'Abrir',
    onAction: () => openChild(child.id),
  })
}

// Reserva do pulso. Só ociosa → trabalhando: quem tira a filha de "aguardando
// você" é o próprio usuário respondendo o menu, e a resposta dele não é novidade.
function markResumed(prev: LiveSessionInfo[], next: LiveSessionInfo[]): void {
  const wasIdle = new Set(prev.filter((s) => s.status === 'idle').map((s) => s.id))
  const resumed = next.filter(
    (s) => s.status === 'working' && wasIdle.has(s.id) && backgroundChild(s.id),
  )
  if (resumed.length === 0) return
  const { unread } = useChildActivityStore.getState()
  const fresh = resumed.filter((s) => !unread[s.id])
  if (fresh.length === 0) return
  useChildActivityStore.setState({
    unread: { ...unread, ...Object.fromEntries(fresh.map((s) => [s.id, 'activity' as const])) },
  })
}

// Aba aberta, processo morto ou vínculo desfeito: não há mais o que marcar.
function prune(): void {
  const { unread } = useChildActivityStore.getState()
  const ids = Object.keys(unread)
  const kept = ids.filter((id) => backgroundChild(id))
  if (kept.length === ids.length) return
  useChildActivityStore.setState({
    unread: Object.fromEntries(kept.map((id) => [id, unread[id]])),
  })
}

// Assinado uma vez pela vida do app (AppShell).
export function listenChildActivity(): () => void {
  const offs = [
    sessionGraphApi.onLinkPulse(receiveLinkPulse),
    useAppStore.subscribe((state, prev) => {
      if (state.liveSessions !== prev.liveSessions) {
        markResumed(prev.liveSessions, state.liveSessions)
      }
      if (state.liveSessions !== prev.liveSessions || state.panes !== prev.panes) prune()
    }),
    useSessionGraphStore.subscribe(prune),
  ]
  return () => offs.forEach((off) => off())
}
