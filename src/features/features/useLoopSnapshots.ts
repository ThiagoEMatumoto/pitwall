import { useCallback, useEffect, useMemo, useState } from 'react'
import { loopApi } from '@/lib/ipc'
import type { FeatureLoopSnapshot } from '../../../shared/types/ipc'

// Snapshots de VÁRIAS features (a parede precisa do pulso e da vitalidade de
// cada card). O useLoopSnapshot cuida de UMA — o dossiê aberto; aqui o alvo é
// um conjunto pequeno e curado (as pinadas), então N chamadas em paralelo são
// aceitáveis. Se a parede um dia listar tudo, isto vira um `loop:snapshots`.
export function useLoopSnapshots(ids: readonly string[]): Map<string, FeatureLoopSnapshot> {
  const [snapshots, setSnapshots] = useState<Map<string, FeatureLoopSnapshot>>(new Map())
  // Chave estável: um array novo a cada render re-dispararia o effect pra sempre.
  const key = useMemo(() => [...ids].sort().join('|'), [ids])

  const loadOne = useCallback(async (id: string) => {
    try {
      const snapshot = await loopApi.snapshot(id)
      setSnapshots((prev) => new Map(prev).set(id, snapshot))
    } catch {
      // Snapshot é enriquecimento: o card continua de pé com título e stats.
    }
  }, [])

  useEffect(() => {
    const wanted = key === '' ? [] : key.split('|')
    let alive = true
    void Promise.all(
      wanted.map(async (id) => {
        try {
          return [id, await loopApi.snapshot(id)] as const
        } catch {
          return null
        }
      }),
    ).then((pairs) => {
      if (!alive) return
      const next = new Map<string, FeatureLoopSnapshot>()
      for (const pair of pairs) {
        if (pair) next.set(pair[0], pair[1])
      }
      setSnapshots(next)
    })
    return () => {
      alive = false
    }
  }, [key])

  useEffect(() => {
    const wanted = new Set(key === '' ? [] : key.split('|'))
    return loopApi.onUpdated((payload) => {
      if (wanted.has(payload.featureId)) void loadOne(payload.featureId)
    })
  }, [key, loadOne])

  return snapshots
}
