import { selectPinned } from './feature-pin'
import type { Feature } from '../../../shared/types/ipc'

// Feature com (ou sem) stats: `list()` não traz lastRecordAt, `listWithStats()`
// traz. O picker aceita as duas fontes, então a atividade é lida defensivamente.
export type FeatureWithActivity = Feature & { lastRecordAt?: number | null }

// Atividade REAL de uma feature: o último session record quando existe, senão o
// updated_at do índice (mexer em metadado não "sobe" a feature). Fonte ÚNICA —
// a lista, a parede e o picker precisam concordar sobre o que é "recente".
export function featureActivity(f: FeatureWithActivity): number {
  return f.lastRecordAt ?? f.updatedAt
}

export interface PickableOpts {
  /** Só features ligadas a este repo. Ausente/null = todas. */
  repoId?: string | null
  /** Busca por título (substring, case-insensitive). */
  query?: string
}

// Ordem do picker: em foco (pinned, na ordem da parede) primeiro, o resto por
// atividade recente. Arquivadas nunca aparecem — vincular trabalho vivo a uma
// frente encerrada é sempre engano.
export function selectPickableFeatures<T extends FeatureWithActivity>(
  features: T[],
  opts: PickableOpts = {},
): T[] {
  const q = (opts.query ?? '').trim().toLowerCase()
  const visible = features.filter((f) => {
    if (f.archivedAt !== null) return false
    if (opts.repoId && !f.repos.some((l) => l.repoId === opts.repoId)) return false
    if (q && !f.title.toLowerCase().includes(q)) return false
    return true
  })
  const pinned = selectPinned(visible, featureActivity)
  const pinnedIds = new Set(pinned.map((f) => f.id))
  const rest = visible
    .filter((f) => !pinnedIds.has(f.id))
    .sort((a, b) => featureActivity(b) - featureActivity(a))
  return [...pinned, ...rest]
}
