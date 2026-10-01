import { useSessionGraph } from '@/features/sessions/session-graph-store'
import { useAppStore } from '@/store/appStore'

// Sessões vivas do projeto na sidebar, cada uma com a linha de PROPÓSITO embaixo
// — pra não depender de lembrar (ou perguntar) do que se tratava cada uma.
// Filhas de handoff ficam de fora: já aparecem em "Delegações".
export function ProjectSessionPurposes({ projectId }: { projectId: string }) {
  const graph = useSessionGraph()
  const liveSessions = useAppStore((s) => s.liveSessions)
  const focusOrOpenSession = useAppStore((s) => s.focusOrOpenSession)
  const sessions = graph.nodes.filter(
    (n) => n.projectId === projectId && n.status !== 'ended' && !n.childOfHandoffId,
  )
  if (sessions.length === 0) return null

  return (
    <div className="ml-4 mt-1 border-t border-[var(--color-border)]/40 pt-1">
      <div className="px-1 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
        Sessões ({sessions.length})
      </div>
      <ul className="flex flex-col gap-px text-xs">
        {sessions.map((n) => {
          const live = liveSessions.find((s) => s.id === n.sessionId)
          return (
            <li key={n.sessionId}>
              <button
                type="button"
                data-testid="sidebar-session"
                data-session-id={n.sessionId}
                disabled={!live}
                onClick={() => live && void focusOrOpenSession(live)}
                title={n.purpose ?? undefined}
                className="flex w-full min-w-0 flex-col rounded px-1 py-1 text-left transition hover:bg-[var(--color-surface-2)]"
              >
                <span className="truncate text-[var(--color-text)]">
                  {n.title}
                  {n.repoLabel && (
                    <span className="text-[var(--color-text-dim)]"> · {n.repoLabel}</span>
                  )}
                </span>
                {n.purpose && (
                  <span
                    data-testid="sidebar-session-purpose"
                    className="truncate text-[11px] text-[var(--color-text-dim)]"
                  >
                    {n.purpose}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
