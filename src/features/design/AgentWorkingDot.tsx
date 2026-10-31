import { useDesignStore } from '@/store/designStore'
import { useFreshActivity } from './AgentActivityBadge'

// Pulsing dot while Claude has a fresh tool call on the document, open or not.
// pw-pulse is switched off under prefers-reduced-motion (index.css).
export function AgentWorkingDot({ docId }: { docId: string }) {
  const entries = useFreshActivity(useDesignStore((s) => s.activityByDoc[docId]))
  if (entries.length === 0) return null
  return (
    <span
      role="status"
      aria-label="Claude trabalhando"
      title="Claude trabalhando"
      className="pw-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)]"
    />
  )
}
