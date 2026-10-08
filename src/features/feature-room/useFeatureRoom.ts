import { useEffect, useState } from 'react'
import { roomApi } from '@/lib/ipc'
import type { RoomSnapshot } from '../../../shared/types/feature-room'

// undefined = carregando; null = feature inexistente/arquivada.
export function useFeatureRoom(featureId: string | null): {
  snapshot: RoomSnapshot | null | undefined
} {
  const [snapshot, setSnapshot] = useState<{ id: string | null; value: RoomSnapshot | null }>()

  useEffect(() => {
    if (!featureId) return
    let alive = true
    // Guard por id: resposta de uma feature que já saiu da tela é descartada.
    const load = () => {
      void roomApi.get(featureId).then((value) => {
        if (alive) setSnapshot({ id: featureId, value })
      })
    }
    load()
    const off = roomApi.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [featureId])

  if (!featureId) return { snapshot: null }
  return { snapshot: snapshot?.id === featureId ? snapshot.value : undefined }
}
