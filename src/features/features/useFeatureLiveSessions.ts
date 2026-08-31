import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store/appStore'
import { useSessionFeatureStore } from '@/store/sessionFeatureStore'

// Quantas sessões VIVAS cada feature tem agora. O caminho de ida
// (sessions:list-by-feature) custaria uma chamada por card; o índice reverso
// que o chip do header da sessão já mantém responde de graça — só invertemos
// o mapa contra o snapshot global de sessões vivas.
export function useFeatureLiveSessions(): Map<string, number> {
  const bySessionId = useSessionFeatureStore((s) => s.bySessionId)
  const hydrate = useSessionFeatureStore((s) => s.hydrate)
  const liveSessions = useAppStore((s) => s.liveSessions)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  return useMemo(() => {
    const counts = new Map<string, number>()
    for (const session of liveSessions) {
      if (session.status === 'ended') continue
      const featureId = bySessionId[session.id]
      if (!featureId) continue
      counts.set(featureId, (counts.get(featureId) ?? 0) + 1)
    }
    return counts
  }, [liveSessions, bySessionId])
}
