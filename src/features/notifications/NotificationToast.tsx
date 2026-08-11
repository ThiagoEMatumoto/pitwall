import { useEffect, useRef, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { notificationsApi } from '@/lib/ipc'
import { Icon } from '@/components/ui/Icon'
import { crewCcSessionIds } from '@/features/handoffs/crew'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import { useToastStore, type LocalToast } from './toast-store'
import type { NotificationEvent } from '../../../shared/types/ipc'

const AUTO_DISMISS_MS = 6000

// Teto de cards de evento simultâneos: sem cap, várias transições
// working→waiting ao mesmo tempo (ou uma sessão oscilando) cobrem a tela.
const MAX_VISIBLE_EVENTS = 4

interface QueuedEvent extends NotificationEvent {
  // Id local da fila (o `at` do evento pode colidir em eventos simultâneos).
  queueId: number
}

// Coalescing + cap da fila. Toasts de undo (LocalToast) vivem em outra fila e
// nunca passam por aqui — logo nunca são descartados por esta política.
function enqueueEvent(prev: QueuedEvent[], queued: QueuedEvent): QueuedEvent[] {
  // Coalescing por sessão: evento novo da MESMA sessão substitui o card dela
  // (queueId novo remonta o card e reinicia o auto-dismiss) em vez de empilhar
  // duplicata — uma sessão oscilando gera 1 card, não N.
  const withoutSame = queued.ccSessionId
    ? prev.filter((e) => e.ccSessionId !== queued.ccSessionId)
    : prev
  const next = [...withoutSame, queued]
  while (next.length > MAX_VISIBLE_EVENTS) {
    // Excedente: descarta o mais antigo não-acionável (sem sessão pra abrir).
    // Se todos forem acionáveis, cai no mais antigo mesmo — o teto vale mais
    // que preservar um card que o usuário já deixou envelhecer.
    const idx = next.findIndex((e) => !e.ccSessionId)
    next.splice(idx === -1 ? 0 : idx, 1)
  }
  return next
}

// Filhas do Crew Dock não geram toast: o dock já mostra o estado delas o tempo
// todo (dot âmbar, card "aguardando você") e ainda abre sozinho quando alguma
// espera — o toast seria o MESMO aviso duas vezes, por cima do painel que ele
// duplica. getState() porque isto roda no handler do evento, não no render.
function isCrewChild(ccSessionId: string | undefined): boolean {
  if (!ccSessionId) return false
  const { liveSessions } = useAppStore.getState()
  const { handoffs } = useHandoffsStore.getState()
  return crewCcSessionIds(handoffs, liveSessions).has(ccSessionId)
}

// Abre/foca a sessão do evento via snapshot de sessões vivas. getState() em vez
// de hook: chamado de handlers, e a busca é pontual (não precisa re-render).
function openSessionByCc(ccSessionId: string) {
  const { liveSessions, focusOrOpenSession } = useAppStore.getState()
  const item = liveSessions.find((s) => s.ccSessionId === ccSessionId)
  if (item) void focusOrOpenSession(item)
}

export function NotificationToast() {
  const [events, setEvents] = useState<QueuedEvent[]>([])
  const nextId = useRef(0)
  const toasts = useToastStore((s) => s.toasts)

  useEffect(() => {
    // Fila: eventos empilham com coalescing por sessão e teto de cards
    // (ver enqueueEvent); cada card tem auto-dismiss próprio.
    return notificationsApi.onEvent((e) => {
      if (isCrewChild(e.ccSessionId)) return
      nextId.current += 1
      const queued: QueuedEvent = { ...e, queueId: nextId.current }
      setEvents((prev) => enqueueEvent(prev, queued))
    })
  }, [])

  useEffect(() => {
    // Clique na notificação NATIVA: o main já focou a janela; aqui abrimos a sessão.
    return notificationsApi.onOpenSession((ccSessionId) => openSessionByCc(ccSessionId))
  }, [])

  function dismissEvent(queueId: number) {
    setEvents((prev) => prev.filter((e) => e.queueId !== queueId))
  }

  return (
    <>
      {toasts.map((toast) => (
        <LocalToastCard key={toast.id} toast={toast} />
      ))}
      {events.map((event) => (
        <EventToastCard
          key={event.queueId}
          event={event}
          onDismiss={() => dismissEvent(event.queueId)}
        />
      ))}
    </>
  )
}

function EventToastCard({ event, onDismiss }: { event: QueuedEvent; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
    // onDismiss é recriado a cada render do pai (fila muda); o timer é por card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.queueId])

  const activate = event.ccSessionId
    ? () => {
        openSessionByCc(event.ccSessionId!)
        onDismiss()
      }
    : undefined

  return (
    <ToastFrame onDismiss={onDismiss} onActivate={activate}>
      <div className="font-medium">{event.title}</div>
      <div className="text-[var(--color-text-dim)]">{event.body}</div>
    </ToastFrame>
  )
}

function LocalToastCard({ toast }: { toast: LocalToast }) {
  const dismiss = useToastStore((s) => s.dismiss)

  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.id), toast.durationMs)
    return () => clearTimeout(timer)
  }, [toast.id, toast.durationMs, dismiss])

  return (
    <ToastFrame onDismiss={() => dismiss(toast.id)}>
      <div className="font-medium">{toast.title}</div>
      {toast.body && <div className="text-[var(--color-text-dim)]">{toast.body}</div>}
      {toast.actionLabel && (
        <button
          type="button"
          onClick={() => {
            toast.onAction?.()
            dismiss(toast.id)
          }}
          className="mt-1 rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-accent)] transition hover:bg-[var(--color-surface-2)]"
        >
          {toast.actionLabel}
        </button>
      )}
    </ToastFrame>
  )
}

function ToastFrame({
  children,
  onDismiss,
  onActivate,
}: {
  children: React.ReactNode
  onDismiss: () => void
  // Presente = toast acionável: o corpo vira botão que navega pra sessão.
  onActivate?: () => void
}) {
  const body = onActivate ? (
    <button type="button" onClick={onActivate} className="flex-1 text-left">
      {children}
    </button>
  ) : (
    <div className="flex-1">{children}</div>
  )

  return (
    <div
      className="pointer-events-auto flex max-w-xs items-start gap-3 rounded-lg border px-3 py-2 text-sm shadow-lg"
      style={{
        borderColor: 'var(--color-border)',
        background: 'var(--color-bg-elevated, var(--color-surface))',
        color: 'var(--color-text)',
      }}
    >
      <Icon as={Bell} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
      {body}
      <button
        onClick={onDismiss}
        aria-label="Dispensar"
        className="flex shrink-0 items-center px-1"
        style={{ color: 'var(--color-text-dim)' }}
      >
        <Icon as={X} size={14} />
      </button>
    </div>
  )
}
