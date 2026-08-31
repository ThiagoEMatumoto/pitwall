import { useCallback, useEffect, useState } from 'react'
import { selectPinned } from '@/features/features/feature-pin'
import { featuresApi } from '@/lib/ipc'
import type { Feature } from '../../../shared/types/ipc'

// As features em foco pra Home. Vem de features:list e NÃO do agregado do
// overview porque `OverviewFeatureActivity` (shared/) não carrega o pin — e
// shared/ não é editável nesta frente. Uma chamada no mount, mais o broadcast
// que o próprio pin dispara.
export function usePinnedFeatures(): Feature[] {
  const [pinned, setPinned] = useState<Feature[]>([])

  const load = useCallback(async () => {
    try {
      const all = await featuresApi.list()
      setPinned(selectPinned(all, (f) => f.updatedAt))
    } catch {
      // Card degrada pra lista de atividade — a Home nunca quebra por isto.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    return featuresApi.onUpdated(() => void load())
  }, [load])

  return pinned
}
