import { useCallback, useEffect, useState } from 'react'
import { roomApi } from '@/lib/ipc'
import type { RoomSnapshot } from '../../../shared/types/feature-room'

type Loaded =
  { id: string; value: RoomSnapshot | null; failed: false } | { id: string; failed: true }

// undefined = carregando; null = feature inexistente/arquivada.
// failed = room:get rejeitou; retry() tenta de novo.
export function useFeatureRoom(featureId: string | null): {
  snapshot: RoomSnapshot | null | undefined
  failed: boolean
  retry: () => void
} {
  const [loaded, setLoaded] = useState<Loaded>()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!featureId) return
    let alive = true
    // Guard por id: resposta de uma feature que já saiu da tela é descartada.
    const load = () => {
      roomApi.get(featureId).then(
        (value) => {
          if (alive) setLoaded({ id: featureId, value, failed: false })
        },
        (err: unknown) => {
          console.error('[feature-room] room:get failed', err)
          if (alive) setLoaded({ id: featureId, failed: true })
        },
      )
    }
    load()
    const off = roomApi.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [featureId, attempt])

  const retry = useCallback(() => {
    setLoaded(undefined)
    setAttempt((n) => n + 1)
  }, [])

  if (!featureId) return { snapshot: null, failed: false, retry }
  const mine = loaded?.id === featureId ? loaded : undefined
  return {
    snapshot: mine && !mine.failed ? mine.value : undefined,
    failed: mine?.failed ?? false,
    retry,
  }
}
