import type { Feature } from '../../../shared/types/ipc'

// Foco (pin) da feature. As colunas `pinned`/`focusRank` e o IPC de pin/unpin
// nascem no backend da Fase 4 — a UI programa contra a assinatura e degrada
// pra no-op enquanto o canal não existir (mesmo precedente do videoApi em
// src/lib/ipc.ts). Quando `Feature` ganhar os campos, só os casts caem daqui.
export interface PinnedFields {
  pinned?: boolean
  focusRank?: number | null
}

export type PinnableFeature = Feature & PinnedFields

export function isPinned(feature: Feature): boolean {
  return (feature as PinnableFeature).pinned === true
}

export function focusRankOf(feature: Feature): number | null {
  const rank = (feature as PinnableFeature).focusRank
  return typeof rank === 'number' ? rank : null
}

// Ordem da parede: focusRank crescente (1 = primeiro da parede); sem rank vai
// pro fim. Empate (ou ausência dos dois) cai na atividade que o chamador
// informa — a MESMA noção de atividade real da lista, nunca uma paralela.
export function compareFocus<T extends Feature>(activity: (f: T) => number) {
  return (a: T, b: T): number => {
    const ra = focusRankOf(a)
    const rb = focusRankOf(b)
    if (ra !== rb) {
      if (ra === null) return 1
      if (rb === null) return -1
      return ra - rb
    }
    return activity(b) - activity(a)
  }
}

/** Pinadas não-arquivadas, na ordem da parede. */
export function selectPinned<T extends Feature>(features: T[], activity: (f: T) => number): T[] {
  return features.filter((f) => f.archivedAt === null && isPinned(f)).sort(compareFocus(activity))
}
