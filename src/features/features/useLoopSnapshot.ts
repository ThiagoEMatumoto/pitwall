import { useCallback, useEffect, useRef, useState } from 'react'
import { loopApi } from '@/lib/ipc'
import type { FeatureLoopSnapshot } from '../../../shared/types/ipc'

export interface LoopSnapshotState {
  snapshot: FeatureLoopSnapshot | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

// Snapshot do loop da feature aberta. Hook local (molde de useObjectiveLookups)
// em vez de campo no featuresStore: o loop tem canal de broadcast próprio
// ('loop:updated') e ciclo de vida separado do de features — a mesma separação
// que o main já faz entre o namespace `loop` e o `features`.
export function useLoopSnapshot(featureId: string | null): LoopSnapshotState {
  const [snapshot, setSnapshot] = useState<FeatureLoopSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Feature pedida agora: descarta resposta obsoleta se a seleção mudou no
  // meio do await (mesmo guard do select() do featuresStore).
  const wantedId = useRef<string | null>(null)

  const reload = useCallback(async () => {
    const id = featureId
    if (!id) {
      setSnapshot(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const next = await loopApi.snapshot(id)
      if (wantedId.current !== id) return
      setSnapshot(next)
      setError(null)
    } catch (err) {
      if (wantedId.current !== id) return
      setSnapshot(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (wantedId.current === id) setLoading(false)
    }
  }, [featureId])

  useEffect(() => {
    wantedId.current = featureId
    // Zera antes de buscar pra não exibir o pulso da feature anterior.
    setSnapshot(null)
    void reload()
  }, [featureId, reload])

  useEffect(() => {
    // Pulso escrito por sessão/MCP chega sem ação do usuário.
    return loopApi.onUpdated((payload) => {
      if (payload.featureId === featureId) void reload()
    })
  }, [featureId, reload])

  return { snapshot, loading, error, reload }
}
