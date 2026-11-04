import { Clock, TerminalSquare } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { ChatFallbackKind } from '../../../../shared/chat/fallback'
import type { PendingInteractive } from './chat-logic'
import { useChatFallback } from './useChatFallback'

export function ChatWaitBanners({
  pendingPrompt,
  waitInTerminal,
  onToggleMode,
  menuKind = 'unknown',
}: {
  pendingPrompt: PendingInteractive | null
  waitInTerminal: boolean
  onToggleMode?: () => void
  // Menu parseado que o chat não soube mostrar (sem menu = 'unknown').
  menuKind?: ChatFallbackKind
}) {
  // Os banners só aparecem quando o fallback é estável, a mesma condição que o conta: um
  // 'waiting' transitório (diálogo da CLI que acabou de fechar) não pisca na tela.
  const showPending = useChatFallback(pendingPrompt?.kind ?? null, 'pending-without-menu')
  const showUnrecognized = useChatFallback(waitInTerminal ? menuKind : null, 'wait-in-terminal')
  // Só sobra o que nem o parser tolerante leu: o chat diz isso e deixa um link discreto
  // pro terminal (contado em useChatFallback — se virar regra, o contador mostra).
  const terminalLink = onToggleMode && (
    <button
      type="button"
      data-testid="chat-wait-open-terminal"
      onClick={onToggleMode}
      className="flex shrink-0 items-center gap-1 text-xs text-[var(--color-text-dim)] underline hover:text-[var(--color-text)]"
    >
      <Icon as={TerminalSquare} size={12} />
      Abrir terminal
    </button>
  )
  return (
    <>
      {pendingPrompt && showPending && (
        <div className="sticky bottom-0 flex items-center gap-2 rounded-md border border-[var(--color-accent)]/50 bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text)] shadow-lg">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-accent)]" />
          <Icon as={Clock} size={14} className="shrink-0 text-[var(--color-accent)]" />
          <span className="flex-1">
            {pendingPrompt.kind === 'plan'
              ? 'Claude está aguardando sua aprovação do plano, mas o diálogo não foi lido da tela.'
              : 'Claude está aguardando sua resposta, mas a pergunta não foi lida da tela.'}
          </span>
          {terminalLink}
        </div>
      )}
      {showUnrecognized && (
        <div
          data-testid="chat-wait-unrecognized"
          className="sticky bottom-0 flex items-center gap-2 rounded-md border border-[var(--color-warning)]/60 bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text)] shadow-lg"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-warning)]" />
          <Icon as={Clock} size={14} className="shrink-0 text-[var(--color-warning)]" />
          <span className="flex-1">Claude está esperando você numa tela que o chat não reconheceu.</span>
          {terminalLink}
        </div>
      )}
    </>
  )
}
