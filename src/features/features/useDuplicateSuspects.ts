import { useEffect, useState } from 'react'
import { loopApi } from '@/lib/ipc'
import type { Feature } from '../../../shared/types/ipc'
import { DUPLICATE_SUSPECT, duplicateOfFeature } from './feature-issues'

// Teto de sondagem: a fila de triagem faz UMA chamada de snapshot por feature
// candidata, e só quando o usuário abre o filtro. Enquanto não houver um
// `features:list-triage` (ou `duplicateOf` na projeção de Feature), este é o
// preço — limitado pra não virar tempestade de IPC num índice grande.
const PROBE_LIMIT = 60

// Ids das features com suspeita de duplicata. Caminho barato primeiro: se a
// projeção já trouxer o ponteiro persistido (features.duplicate_of), nem
// perguntamos ao loop.
export function useDuplicateSuspects(features: Feature[], enabled: boolean): Set<string> {
  const [probed, setProbed] = useState<Set<string>>(new Set())
  const fromProjection = features.filter((f) => duplicateOfFeature(f) !== null).map((f) => f.id)
  const key = features.map((f) => f.id).join('|')

  useEffect(() => {
    if (!enabled) return
    const ids = key === '' ? [] : key.split('|').slice(0, PROBE_LIMIT)
    let alive = true
    void Promise.all(
      ids.map(async (id) => {
        try {
          const snapshot = await loopApi.snapshot(id)
          return snapshot.issues.some((i) => i.code === DUPLICATE_SUSPECT) ? id : null
        } catch {
          return null
        }
      }),
    ).then((hits) => {
      if (!alive) return
      setProbed(new Set(hits.filter((id): id is string => id !== null)))
    })
    return () => {
      alive = false
    }
  }, [enabled, key])

  const all = new Set(probed)
  for (const id of fromProjection) all.add(id)
  return all
}
