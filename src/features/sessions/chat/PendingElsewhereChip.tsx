import { ShieldQuestion } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { isActionableDetail } from '@/features/session-switcher/AttentionPopover'
import type { AttentionItem } from '@/features/session-switcher/attention-queue'
import { cycleAttention, useAttentionQueue } from '@/features/session-switcher/useAttentionQueue'
import { pendingElsewhereLabel } from './permission-view'

// Outras sessões com prompt respondível (permissão/trust/pergunta), sem a aberta.
export function waitingElsewhere(queue: AttentionItem[], sessionId: string): AttentionItem[] {
  return queue.filter((i) => isActionableDetail(i.detail) && i.sessionId !== sessionId)
}

// Chip discreto no chat: o clique pula para a próxima da fila (mesmo Alt+A).
export function PendingElsewhereChip({ sessionId }: { sessionId: string }) {
  const others = waitingElsewhere(useAttentionQueue(), sessionId)
  if (others.length === 0) return null
  return (
    <button
      type="button"
      data-testid="pending-elsewhere-chip"
      onClick={() => cycleAttention(others, 1)}
      title="Abrir a próxima sessão que pede sua decisão (Alt+A)"
      className="pw-pop absolute right-4 top-3 z-20 flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-text-dim)] shadow-md transition-colors hover:border-[var(--color-warning)] hover:text-[var(--color-text)]"
    >
      <Icon as={ShieldQuestion} size={12} className="text-[var(--color-warning)]" />
      {pendingElsewhereLabel(others.length)}
    </button>
  )
}
