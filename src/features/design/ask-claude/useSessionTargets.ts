import { useMemo } from 'react'
import { useAppStore } from '@/store/appStore'

export interface SessionTarget {
  sessionId: string
  label: string
  // Project / repo the session lives in; null for a scratch session.
  detail: string | null
  paneId: string | null
}

export interface SessionTargets {
  targets: SessionTarget[]
  // Focused pane first; the composer falls back to the first running session.
  defaultTarget: SessionTarget | null
}

// Running sessions the composer can write to: open panes first (they are what
// the user sees), then background sessions from the global live list.
export function useSessionTargets(): SessionTargets {
  const panes = useAppStore((s) => s.panes)
  const liveSessions = useAppStore((s) => s.liveSessions)
  const focusPaneId = useAppStore((s) => s.focusPaneId)

  return useMemo(() => {
    const targets: SessionTarget[] = []
    const seen = new Set<string>()

    for (const pane of panes) {
      if (pane.session.status !== 'running') continue
      seen.add(pane.session.id)
      targets.push({
        sessionId: pane.session.id,
        label: pane.session.title ?? pane.repo?.label ?? pane.projectName ?? 'Sessão avulsa',
        detail: pane.projectName ?? pane.repo?.label ?? null,
        paneId: pane.paneId,
      })
    }

    for (const live of liveSessions) {
      if (live.status === 'ended' || seen.has(live.id)) continue
      seen.add(live.id)
      targets.push({
        sessionId: live.id,
        label: live.title ?? live.name ?? live.repo?.label ?? 'Sessão avulsa',
        detail: live.projectName ?? live.repo?.label ?? null,
        paneId: null,
      })
    }

    const focused = focusPaneId ? targets.find((t) => t.paneId === focusPaneId) : undefined
    return { targets, defaultTarget: focused ?? targets[0] ?? null }
  }, [panes, liveSessions, focusPaneId])
}
