import { useMemo, useState, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronRight, MessageCircle } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { agentBusApi } from '@/lib/ipc'
import type {
  AgentBusCounters,
  AgentBusSnapshot,
  AgentMessageView,
} from '../../../shared/types/agent-bus'
import type { PendingAsk } from '../session-canvas/graph-to-flow'

// Conversas: agentes perguntando uns aos outros (P7). Livre, sem aprovação — por
// isso a aba existe: o usuário VÊ quem perguntou o quê a quem, a resposta, e
// quantas vezes as guardas barraram (profundidade, rate limit, expiração).

const EMPTY: AgentBusSnapshot = {
  messages: [],
  counters: {
    asked: 0,
    delivered: 0,
    answered: 0,
    expired: 0,
    rejectedDepth: 0,
    rejectedRate: 0,
    rejectedSelf: 0,
    undeliverable: 0,
    needsHandoff: 0,
    wokeDormant: 0,
    wakeFailed: 0,
  },
}

// Um snapshot por janela, compartilhado pela aba e pelo mapa.
let current = EMPTY
let started = false
const listeners = new Set<() => void>()

function publish(next: AgentBusSnapshot): void {
  current = next
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  if (!started) {
    started = true
    agentBusApi.onUpdated(publish)
    void agentBusApi
      .list()
      .then(publish)
      .catch(() => {})
  }
  return () => listeners.delete(fn)
}

export function useAgentBusSnapshot(): AgentBusSnapshot {
  return useSyncExternalStore(subscribe, () => current)
}

// Fios temporários do mapa: só o que ainda espera resposta.
export function usePendingAsks(): PendingAsk[] {
  const { messages } = useAgentBusSnapshot()
  return useMemo(
    () =>
      messages
        .filter((m) => m.status === 'pending' && m.toSessionId)
        .map((m) => ({ id: m.id, from: m.fromSessionId, to: m.toSessionId!, text: m.text })),
    [messages],
  )
}

const STATUS: Record<AgentMessageView['status'], { label: string; color: string }> = {
  pending: { label: 'esperando', color: 'var(--color-info)' },
  answered: { label: 'respondida', color: 'var(--color-success)' },
  expired: { label: 'expirou', color: 'var(--color-text-dim)' },
}

function statusOf(m: AgentMessageView): { label: string; color: string } {
  if (m.status === 'pending' && m.deliveredAt == null) {
    return { label: 'na fila', color: 'var(--color-warning)' }
  }
  return STATUS[m.status]
}

const GUARDS: Array<{ key: keyof AgentBusCounters; label: string; hint: string }> = [
  { key: 'expired', label: 'expiradas', hint: 'Sem resposta em 15 min' },
  {
    key: 'rejectedDepth',
    label: 'profundidade',
    hint: 'Recusadas: cadeia de perguntas acima de 3 níveis',
  },
  { key: 'rejectedRate', label: 'rate limit', hint: 'Recusadas: muitas perguntas ao mesmo par' },
  { key: 'rejectedSelf', label: 'a si mesma', hint: 'Recusadas: a sessão perguntou a ela própria' },
  { key: 'undeliverable', label: 'sem entrega', hint: 'O destino não podia receber' },
  { key: 'needsHandoff', label: 'sem sessão', hint: 'Repo sem sessão viva: sugerido handoff' },
  { key: 'wakeFailed', label: 'não acordou', hint: 'O destino dormia e o wake falhou' },
]

function GuardCounters({ counters }: { counters: AgentBusCounters }) {
  return (
    <div
      data-testid="conversations-counters"
      className="flex flex-wrap gap-1 border-b border-[var(--color-border)] px-2 py-1.5"
    >
      {GUARDS.map((g) => {
        const n = counters[g.key]
        return (
          <span
            key={g.key}
            title={g.hint}
            data-counter={g.key}
            className="rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] tabular-nums"
            style={{ color: n > 0 ? 'var(--color-warning)' : 'var(--color-text-dim)' }}
          >
            {g.label} {n}
          </span>
        )
      })}
    </div>
  )
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function ConversationRow({ m }: { m: AgentMessageView }) {
  const [open, setOpen] = useState(false)
  const status = statusOf(m)
  return (
    <li
      data-testid="conversation-row"
      data-ask-id={m.id}
      data-status={m.status}
      className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-1.5 text-left"
        aria-expanded={open}
      >
        <Icon
          as={open ? ChevronDown : ChevronRight}
          size={12}
          className="mt-0.5 shrink-0 text-[var(--color-text-dim)]"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 text-[11px] text-[var(--color-text-dim)]">
            {/* A origem trunca primeiro: o destinatário é o que se procura no
                par e só encolhe se sozinho passar de 3/4 da linha. */}
            <span
              className="flex min-w-0 flex-1 items-center gap-1"
              data-testid="conversation-pair"
              title={`${m.fromLabel} → ${m.toLabel}`}
            >
              <span className="min-w-0 truncate">{m.fromLabel}</span>
              <span className="shrink-0">→</span>
              <span className="max-w-[75%] shrink-0 truncate text-[var(--color-text)]">
                {m.toLabel}
              </span>
            </span>
            <span className="shrink-0 font-mono tabular-nums">{time(m.createdAt)}</span>
          </span>
          {/* O status mora na linha do texto: na do par ele comia a largura do
              destinatário. */}
          <span className="flex items-start gap-1.5">
            <span
              className={`min-w-0 flex-1 text-xs text-[var(--color-text)] ${open ? 'whitespace-pre-wrap' : 'truncate'}`}
            >
              {m.text}
            </span>
            <span
              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
              style={{
                color: status.color,
                background: `color-mix(in srgb, ${status.color} 14%, transparent)`,
              }}
            >
              {status.label}
            </span>
          </span>
        </span>
      </button>
      {open && (
        <div className="mt-1.5 border-t border-[var(--color-border)] pt-1.5 pl-[18px] text-xs">
          {m.reply ? (
            <p
              data-testid="conversation-reply"
              className="whitespace-pre-wrap text-[var(--color-text)]"
            >
              {m.reply}
            </p>
          ) : (
            <p className="text-[var(--color-text-dim)]">
              {m.status === 'expired' ? 'Expirou sem resposta.' : 'Ainda sem resposta.'}
            </p>
          )}
          <p className="mt-1 text-[10px] text-[var(--color-text-dim)]">
            profundidade {m.depth}
            {m.answeredAt ? ` · respondida às ${time(m.answeredAt)}` : ''}
          </p>
        </div>
      )}
    </li>
  )
}

export function ConversationsTab() {
  const { messages, counters } = useAgentBusSnapshot()
  return (
    <div data-testid="conversations-tab" className="flex min-h-0 flex-1 flex-col">
      <GuardCounters counters={counters} />
      {messages.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-[var(--color-text-dim)]">
          <Icon as={MessageCircle} size={18} />
          <p>
            Nenhuma conversa entre agentes ainda. Quando uma sessão perguntar algo a outra
            (agent_ask), aparece aqui.
          </p>
        </div>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
          {messages.map((m) => (
            <ConversationRow key={m.id} m={m} />
          ))}
        </ul>
      )}
    </div>
  )
}
