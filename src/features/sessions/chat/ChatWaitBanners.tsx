import { Clock, TerminalSquare } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { PendingInteractive } from './chat-logic'

export function ChatWaitBanners({
  pendingPrompt,
  waitInTerminal,
  onToggleMode,
}: {
  pendingPrompt: PendingInteractive | null
  waitInTerminal: boolean
  onToggleMode?: () => void
}) {
  return (
    <>
      {pendingPrompt && (
        <div className="sticky bottom-0 flex items-center gap-2 rounded-md border border-[var(--color-accent)]/50 bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text)] shadow-lg">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-accent)]" />
          <Icon as={Clock} size={14} className="shrink-0 text-[var(--color-accent)]" />
          {pendingPrompt.kind === 'plan'
            ? 'Claude está aguardando sua aprovação do plano — responda no compositor ou no terminal.'
            : 'Claude está aguardando sua resposta — responda no compositor ou no terminal.'}
        </div>
      )}
      {/* Espera genérica (TTY-only): o chat não tem card pra mostrar. Direciona ao
          terminal, único lugar que renderiza o prompt (ex.: permissão y/n). */}
      {waitInTerminal && (
        <div className="sticky bottom-0 flex items-center gap-2 rounded-md border border-[var(--color-warning)]/60 bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text)] shadow-lg">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-warning)]" />
          <Icon as={Clock} size={14} className="shrink-0 text-[var(--color-warning)]" />
          <span className="flex-1">
            Claude está aguardando sua resposta no terminal (ex.: permissão). Abra o Terminal pra
            responder.
          </span>
          {onToggleMode && (
            <button
              type="button"
              onClick={onToggleMode}
              className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs font-medium hover:border-[var(--color-warning)]"
            >
              <Icon as={TerminalSquare} size={13} />
              Ir pro Terminal
            </button>
          )}
        </div>
      )}
    </>
  )
}
