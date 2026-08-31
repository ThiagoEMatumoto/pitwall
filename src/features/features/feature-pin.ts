import type { Feature } from '../../../shared/types/ipc'

// Leitura do foco da parede (colunas pinned/focus_rank, migration 043). Módulo
// PURO de propósito: entra na lista, no card e na parede — tocar '@/lib/ipc'
// aqui obrigaria todo consumidor a mockar window.api. A escrita vive em
// feature-pin-api.ts (mesma separação de feature-sessions-api.ts).
//
// Os campos são opcionais no tipo (projeções antigas não os preenchem), então
// a ausência é lida como "não fixada" em vez de quebrar.
export function isPinned(feature: Feature): boolean {
  return feature.pinned === true
}

export function focusRankOf(feature: Feature): number | null {
  return typeof feature.focusRank === 'number' ? feature.focusRank : null
}

// Ordem da parede: focusRank crescente (1 = primeiro); sem rank vai pro fim.
// Empate (ou ausência dos dois) cai na atividade que o chamador informa — a
// MESMA noção de atividade real da lista, nunca uma paralela.
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
