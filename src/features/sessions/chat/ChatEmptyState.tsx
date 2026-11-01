import type { CSSProperties, ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

interface ChatEmptyStateProps {
  viewState: 'loading' | 'waiting' | 'empty'
  children?: ReactNode
  // Substitui o convite padrão (peek só-leitura: não há campo "abaixo").
  hint?: string
}

export function ChatEmptyState({ viewState, children, hint }: ChatEmptyStateProps) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 overflow-y-auto bg-[var(--color-bg)] p-6">
      {viewState === 'loading' ? (
        <LoadingSkeleton />
      ) : hint ? (
        <p data-testid="chat-empty-hint" className="text-center text-sm text-[var(--color-text-dim)]">
          {hint}
        </p>
      ) : (
        <div className="flex flex-col items-center gap-2 text-center">
          <span
            className="chat-welcome-glow text-[var(--color-accent)]"
            style={{ '--i': 0 } as CSSProperties}
          >
            <Icon as={Sparkles} size={28} />
          </span>
          <p
            className="chat-welcome-rise text-sm text-[var(--color-text)]"
            style={{ '--i': 1 } as CSSProperties}
          >
            Pronto quando você estiver.
          </p>
          <p
            className="chat-welcome-rise text-xs text-[var(--color-text-dim)]"
            style={{ '--i': 2 } as CSSProperties}
          >
            Digite seu prompt abaixo para começar.
          </p>
        </div>
      )}
      {children}
    </div>
  )
}

// Silhueta da conversa que está chegando (bolha do humano à direita, prosa do
// agente à esquerda): o layout não pula quando o transcript pinta.
const SKELETON_LINES = ['92%', '78%', '85%', '40%']

function LoadingSkeleton() {
  return (
    <div
      role="status"
      aria-label="Carregando conversa…"
      data-testid="chat-loading"
      className="chat-skeleton mx-auto flex w-full max-w-[780px] flex-col gap-6 px-6"
    >
      <div className="ml-auto h-9 w-[46%] rounded-[16px_16px_4px_16px] bg-[var(--color-surface-2)]" />
      <div className="flex flex-col gap-2.5">
        {SKELETON_LINES.map((w, i) => (
          <div key={i} className="h-3 rounded-full bg-[var(--color-surface-2)]" style={{ width: w }} />
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <div className="h-3 w-[34%] rounded-full bg-[var(--color-surface)]" />
        <div className="h-3 w-[28%] rounded-full bg-[var(--color-surface)]" />
      </div>
      <span className="text-center text-xs text-[var(--color-text-dim)]">Carregando conversa…</span>
    </div>
  )
}
