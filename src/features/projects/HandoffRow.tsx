import { useAppStore } from '@/store/appStore'
import { StatusBadge, liveBadgeFor } from '@/features/handoffs/HandoffCard'
import type { Handoff } from '../../../shared/types/ipc'

interface Props {
  handoff: Handoff
}

// Linha COMPACTA de handoff pra sidebar de projetos (~288px) — o HandoffCard
// cheio é largo demais. Mostra label do repo-alvo, badge de status e, quando a
// filha está viva, um badge "ao vivo". Clicar foca a sessão-filha viva (re-attacha
// a pane) ou cai na área dedicada de handoffs.
export function HandoffRow({ handoff }: Props) {
  const liveSessions = useAppStore((s) => s.liveSessions)
  const focusOrOpenSession = useAppStore((s) => s.focusOrOpenSession)
  const setArea = useAppStore((s) => s.setArea)

  const repoLabel = handoff.targetRepoLabel ?? handoff.targetRepoId
  // A filha só está num PTY enquanto o handoff está vivo (running/needs_input).
  const isLiveHandoff = handoff.status === 'running' || handoff.status === 'needs_input'
  const childLive =
    isLiveHandoff && handoff.childSessionId
      ? liveSessions.find((s) => s.id === handoff.childSessionId)
      : undefined
  const live = isLiveHandoff ? liveBadgeFor(childLive?.status) : null

  function onClick() {
    if (childLive) {
      void focusOrOpenSession(childLive)
    } else {
      setArea('handoffs')
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={handoff.task}
      className="group flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-1 text-left text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
    >
      <span className="shrink-0 text-[var(--color-text-dim)]">→</span>
      <span className="min-w-0 flex-1 truncate">{repoLabel}</span>
      {live && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1 py-0.5 text-[9px] font-medium"
          style={{ color: live.color, borderColor: live.color, background: `${live.color}1a` }}
          title="Estado ao vivo da sessão-filha"
        >
          <span className="h-1 w-1 rounded-full" style={{ background: live.color }} />
          {live.label}
        </span>
      )}
      <span className="shrink-0">
        <StatusBadge status={handoff.status} />
      </span>
    </button>
  )
}
