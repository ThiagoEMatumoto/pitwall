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
        <div className="flex flex-col items-center gap-2 text-center text-sm text-[var(--color-text-dim)]">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-text-dim)]" />
          Carregando conversa…
        </div>
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
