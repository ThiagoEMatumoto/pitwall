import { useEffect } from 'react'
import { useLoopSnapshot } from '@/features/features/useLoopSnapshot'
import { useSessionFeatureStore } from '@/store/sessionFeatureStore'
import type { Liveness, LoopIssue } from '../../../shared/feature-loop'

export interface SessionFeature {
  id: string
  title: string
  liveness: Liveness | null
  lastActivityAt: number | null
  issues: readonly LoopIssue[]
}

// A feature desta sessão, pronta pro chip do header. `null` quando a sessão não
// tem feature (ou o índice reverso ainda não sabe dizer).
export function useSessionFeature(sessionId: string): SessionFeature | null {
  const featureId = useSessionFeatureStore((s) => s.bySessionId[sessionId] ?? null)
  const title = useSessionFeatureStore((s) =>
    featureId ? (s.featureTitles[featureId] ?? null) : null,
  )
  const hydrate = useSessionFeatureStore((s) => s.hydrate)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  const loop = useLoopSnapshot(featureId)

  if (!featureId || !title) return null
  return {
    id: featureId,
    title,
    liveness: loop.snapshot?.liveness ?? null,
    lastActivityAt: loop.snapshot?.lastActivityAt ?? null,
    issues: loop.snapshot?.issues ?? [],
  }
}
