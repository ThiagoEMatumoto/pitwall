import { memo, useEffect, useState, type KeyboardEvent } from 'react'
import { Crown, Maximize2, Pin } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { peekAttentionItem } from '@/features/handoffs/peek-attention'
import { CardPromptBar } from '@/features/session-canvas/SessionCardLive'
import { AttentionMenuPanel } from '@/features/session-switcher/AttentionPopover'
import { useChatTail } from '@/features/sessions/chat/useChatTail'
import { useAppStore } from '@/store/appStore'
import type { ChatMessage } from '../../../shared/types/chat'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import { stripUnsafeDisplay } from '../../../shared/tui/permission-request'
import { sinceText } from './room-labels'

export type TileLiveState = 'live' | 'paused'

const ECHO_MS = 10_000
const TEXT_MAX = 280

interface Props {
  node: SessionGraphNode
  index: number
  featureTitle: string | null
  ownNeed: number // itens do needYou que são da própria mãe
  kidsNeed: number // itens do needYou das filhas
  ownMenuWhy: string | null // whyNow do session_menu dela (o comando completo vai no title)
  live: boolean
  pinned: boolean
  now: number
  onOpen: (node: SessionGraphNode) => void
  onPin: (node: SessionGraphNode) => void
}

function clip(text: string): string {
  const t = stripUnsafeDisplay(text).trim()
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX)}…` : t
}

function TailLine({ m, title }: { m: ChatMessage; title: string }) {
  if (m.kind === 'user')
    return <div className="text-[12.5px] text-[var(--color-text-dim)]">você: {clip(m.text)}</div>
  if (m.kind === 'assistant')
    return (
      <div className="text-[12.5px]">
        <b className="mr-1 font-semibold">{title}</b>
        {clip(m.text)}
      </div>
    )
  if (m.kind === 'tool_use' || m.kind === 'subagent')
    return (
      <div className="font-mono text-[11.5px] text-[var(--color-text-dim)]">⎿ {clip(m.name)}</div>
    )
  return null
}

const SHOWN: ReadonlySet<ChatMessage['kind']> = new Set([
  'user',
  'assistant',
  'tool_use',
  'subagent',
])

// Um tile do nível "Todas as mães": DOM puro, sem Terminal nem xterm. A cauda vem
// do chat:watch-tail (só com `live`), o envio do CardPromptBar (sessions:send-prompt)
// e a aprovação do AttentionMenuPanel (sessions:attention-respond com fingerprint).
export const MotherTile = memo(function MotherTile({
  node,
  index,
  featureTitle,
  ownNeed,
  kidsNeed,
  ownMenuWhy,
  live,
  pinned,
  now,
  onOpen,
  onPin,
}: Props) {
  const liveInfo = useAppStore((s) =>
    s.liveSessions.find((l) => l.id === node.sessionId && l.status !== 'ended'),
  )
  const { messages } = useChatTail(node.sessionId, live, node.ccSessionId ?? null)
  const [echo, setEcho] = useState<{ text: string; at: number } | null>(null)
  const title = stripUnsafeDisplay(node.cliName ?? node.title)
  const repo = node.repoLabel ? stripUnsafeDisplay(node.repoLabel) : ''
  const feature = featureTitle ? stripUnsafeDisplay(featureTitle) : 'Sem feature'
  const need = ownNeed + kidsNeed
  const status =
    need > 0
      ? { text: 'esperando você', cls: 'text-[var(--color-danger)] font-semibold' }
      : node.status === 'working'
        ? { text: 'trabalhando', cls: 'text-[var(--color-text-dim)]' }
        : {
            text:
              node.lastActivityAt != null
                ? `parada ${sinceText(node.lastActivityAt, now)}`
                : 'parada',
            cls: 'text-[var(--color-warning)]',
          }
  const menuItem = ownMenuWhy != null ? peekAttentionItem(liveInfo ?? null, null) : null
  const tail = messages.filter((m) => SHOWN.has(m.kind)).slice(-5)
  const echoReached =
    echo != null && tail.some((m) => m.kind === 'user' && m.text.trim() === echo.text)

  useEffect(() => {
    if (!echo) return
    if (echoReached) {
      setEcho(null)
      return
    }
    const t = window.setTimeout(() => setEcho(null), Math.max(0, echo.at + ECHO_MS - Date.now()))
    return () => window.clearTimeout(t)
  }, [echo, echoReached])

  const onTileKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target === e.currentTarget && e.key === 'Enter') {
      e.preventDefault()
      onOpen(node)
    }
  }
  // O eco otimista lê o texto antes do CardPromptBar limpá-lo (ele trata o Enter).
  const onComposerKeyCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      ;(e.currentTarget.closest('[data-tile]') as HTMLElement | null)?.focus()
      return
    }
    if (e.key !== 'Enter' || e.shiftKey || !(e.target instanceof HTMLTextAreaElement)) return
    const text = e.target.value.trim()
    if (text) setEcho({ text, at: Date.now() })
  }

  return (
    <article
      data-tile={node.sessionId}
      data-tile-index={index}
      data-live={live ? 'live' : 'paused'}
      data-testid="mother-tile"
      tabIndex={0}
      role="listitem"
      aria-label={`${title}, ${feature}, ${status.text}. Enter abre a sala.`}
      onKeyDown={onTileKey}
      className={`relative flex min-h-[250px] min-w-0 flex-col rounded-[10px] border bg-[var(--color-surface)] outline-none transition focus-visible:border-[var(--color-accent)] focus-visible:shadow-[0_0_0_1px_var(--color-accent)] ${
        need > 0
          ? 'border-[var(--color-border)] border-t-[3px] border-t-[var(--color-danger)]'
          : 'border-[var(--color-border)] hover:border-[var(--color-accent)]'
      }`}
    >
      <header className="flex items-start gap-2 border-b border-[var(--color-border)] px-2.5 pb-1.5 pt-2">
        {index < 9 && (
          <kbd
            title={`Tecla ${index + 1} foca este tile`}
            className="mt-0.5 rounded border border-[var(--color-border)] px-1 font-mono text-[10.5px] text-[var(--color-text-dim)]"
          >
            {index + 1}
          </kbd>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13.5px] font-semibold">
            <Icon as={Crown} size={12} className="shrink-0 text-[var(--color-accent)]" />
            <span className="min-w-0 truncate" data-testid="mother-tile-title">
              {title}
            </span>
            <span
              data-testid="mother-tile-status"
              className={`ml-auto shrink-0 whitespace-nowrap text-[11.5px] font-normal ${status.cls}`}
            >
              {status.text}
            </span>
          </div>
          <div
            className="truncate text-[11.5px] text-[var(--color-text-dim)]"
            title={`${feature}${repo ? ` · ${repo}` : ''}`}
          >
            {feature}
            {repo && <span className="font-mono text-[11px]"> · {repo}</span>}
          </div>
        </div>
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={`${pinned ? 'Desafixar' : 'Fixar'} ${title}`}
          title={pinned ? 'Desafixar' : 'Fixar: o tile fica no lugar e não reordena'}
          data-testid="mother-tile-pin"
          onClick={() => onPin(node)}
          className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border ${
            pinned
              ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
          }`}
        >
          <Icon as={Pin} size={13} />
        </button>
        <button
          type="button"
          aria-label={`Abrir a sala de ${title}`}
          title="Abrir a sala da feature (Enter)"
          data-testid="mother-tile-open"
          onClick={() => onOpen(node)}
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
        >
          <Icon as={Maximize2} size={13} />
        </button>
      </header>
      <div
        data-testid="mother-tile-tail"
        aria-live="polite"
        className={`flex min-h-0 flex-1 flex-col justify-end gap-1 overflow-hidden px-2.5 py-2 max-[1279px]:[&>[data-msg]:nth-last-child(n+4)]:hidden ${
          live ? '' : 'opacity-60'
        }`}
      >
        {tail.map((m, i) => (
          <div key={i} data-msg>
            <TailLine m={m} title={title} />
          </div>
        ))}
        {echo && !echoReached && (
          <div
            data-msg
            data-testid="mother-tile-echo"
            className="text-[12.5px] text-[var(--color-text-dim)]"
          >
            você: {clip(echo.text)} <span className="italic">enviando…</span>
          </div>
        )}
        {!live && (
          <span
            className="text-[11px] text-[var(--color-text-dim)]"
            data-testid="mother-tile-paused"
          >
            pausado · fora da tela
          </span>
        )}
      </div>
      {ownMenuWhy != null && (
        <div
          role="group"
          aria-label={`Pedido de ${title}`}
          data-testid="mother-tile-menu"
          title={stripUnsafeDisplay(ownMenuWhy)}
          className="flex flex-col gap-1.5 border-t border-[var(--color-border)] px-2.5 py-2 text-[12px]"
        >
          {menuItem ? (
            <AttentionMenuPanel item={menuItem} />
          ) : (
            <p className="m-0 text-[var(--color-text-dim)]">Responda no terminal.</p>
          )}
          <button
            type="button"
            onClick={() => onOpen(node)}
            aria-label={`Ver contexto de ${title}`}
            className="w-max text-[11.5px] text-[var(--color-text-dim)] underline hover:text-[var(--color-text)]"
          >
            Ver contexto
          </button>
        </div>
      )}
      <footer className="flex flex-col gap-1.5 border-t border-[var(--color-border)] px-2.5 py-2">
        <div className="flex items-center gap-2 text-[11.5px] text-[var(--color-text-dim)]">
          <span data-testid="mother-tile-own">pedidos dela {ownNeed}</span>
          {kidsNeed > 0 ? (
            <button
              type="button"
              data-testid="mother-tile-kids"
              onClick={() => onOpen(node)}
              aria-label={`${kidsNeed} pedidos das filhas de ${title}. Abrir sala`}
              className="font-semibold text-[var(--color-danger)] hover:underline"
            >
              {kidsNeed} {kidsNeed === 1 ? 'pedido' : 'pedidos'} das filhas · Abrir sala
            </button>
          ) : (
            <span data-testid="mother-tile-kids">filhas 0</span>
          )}
        </div>
        <div
          data-tile-composer
          role="group"
          aria-label={`Mensagem para ${title}`}
          onKeyDownCapture={onComposerKeyCapture}
        >
          <CardPromptBar node={node} />
        </div>
      </footer>
    </article>
  )
})
