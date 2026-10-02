import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Bell, X } from 'lucide-react'
import { notificationsApi } from '@/lib/ipc'
import { Icon } from '@/components/ui/Icon'
import { crewCcSessionIds } from '@/features/handoffs/crew'
import { openSessionByCc } from '@/features/sessions/open-session'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import { useBarPillStore, useToastStore, type LocalToast } from './toast-store'
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

// maxVisible: teto vindo do placement (mapa = 2; modal sem respiro = 0). O
// excedente colapsa num "+N" mas continua montado (escondido): o auto-dismiss
// de cada card segue correndo e eles somem sozinhos.
// expandable: o "+N" do teto 0 ainda abre no clique (barra do mapa estreito).
// pinned: card de fora da fila (o de atualização), contado no teto e no "+N" —
// solto da pilha, ele ficava à vista em cima dos cartões do mapa estreito.
export function NotificationToast({
  maxVisible,
  expandable = false,
  pinned,
}: { maxVisible?: number; expandable?: boolean; pinned?: ReactNode } = {}) {
  const [expanded, setExpanded] = useState(false)
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

  const cards = [
    ...(pinned ? [{ key: 'pinned', node: pinned }] : []),
    ...toasts.map((toast) => ({ key: `t${toast.id}`, node: <LocalToastCard toast={toast} /> })),
    ...events.map((event) => ({
      key: `e${event.queueId}`,
      node: <EventToastCard event={event} onDismiss={() => dismissEvent(event.queueId)} />,
    })),
  ]
  // Na faixa estreita acima/abaixo da modal (teto 0) não há onde expandir: os
  // cards cresceriam por cima da modal. O "+N" vira só um contador.
  const canExpand = maxVisible !== 0 || expandable
  const cap =
    (expanded && canExpand) || maxVisible === undefined ? cards.length : Math.max(0, maxVisible)
  const hiddenCount = Math.max(0, cards.length - cap)
  // Some o "+N" → volta ao teto na próxima rajada.
  useEffect(() => {
    if (cards.length <= (maxVisible ?? cards.length)) setExpanded(false)
  }, [cards.length, maxVisible])

  // No mapa estreito o "+N" fica no canto da barra: ela reserva a largura dele.
  // Expandido, ele vira "Recolher" e segue lá: sem ele a reserva caía e o 1º card
  // (a pilha começa no topo da barra) cobria o fim dela.
  const barMode = expandable && maxVisible === 0
  const collapsible = barMode && expanded && hiddenCount === 0 && cards.length > 0
  const inBar = barMode && (hiddenCount > 0 || collapsible)
  const pillRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const width = inBar ? (pillRef.current?.offsetWidth ?? 0) : 0
    if (useBarPillStore.getState().width !== width) useBarPillStore.setState({ width })
  }, [inBar, hiddenCount, collapsible])
  useEffect(() => () => useBarPillStore.setState({ width: 0 }), [])

  return (
    <>
      {(hiddenCount > 0 || collapsible) && (
        <button
          ref={pillRef}
          type="button"
          data-testid="toast-overflow"
          onClick={
            collapsible ? () => setExpanded(false) : canExpand ? () => setExpanded(true) : undefined
          }
          aria-disabled={!canExpand}
          title={
            collapsible
              ? 'Recolher os avisos'
              : canExpand
                ? 'Mostrar todos os avisos'
                : 'Feche o terminal para ver os avisos'
          }
          className="pointer-events-auto rounded-full border px-2.5 py-1 text-xs shadow-lg"
          style={{
            borderColor: 'var(--color-border)',
            background: 'var(--color-bg-elevated, var(--color-surface))',
            color: 'var(--color-text-dim)',
          }}
        >
          {collapsible ? 'Recolher' : `+${hiddenCount} ${hiddenCount === 1 ? 'aviso' : 'avisos'}`}
        </button>
      )}
      {cards.map((c, i) => (
        <div key={c.key} hidden={i < hiddenCount} data-testid="toast-card">
          {c.node}
        </div>
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
      <div className="line-clamp-2 text-[var(--color-text-dim)]" title={event.body}>
        {event.body}
      </div>
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
      {/* 2 linhas no máximo (o aviso do bastão ocupava 5); o texto inteiro no title. */}
      {toast.body && (
        <div className="line-clamp-2 text-[var(--color-text-dim)]" title={toast.body}>
          {toast.body}
        </div>
      )}
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
