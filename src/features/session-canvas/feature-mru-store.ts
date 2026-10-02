import { create } from 'zustand'

// Features visitadas, da mais recente para a mais antiga: a ordem do seletor
// rápido (Ctrl+`). As chaves são as do seletor: o featureId, ou `p:<projeto>`
// para o grupo "Sem feature" de cada projeto. Preferência local do renderer.
const PERSIST_KEY = 'cm:feature-mru'
const MAX_MRU = 30

export function touchFeatureMru(order: string[], key: string, max = MAX_MRU): string[] {
  return [key, ...order.filter((k) => k !== key)].slice(0, max)
}

// `keys` vem do grafo (o que existe agora, na ordem do mapa). A atual (feature
// em foco, ou o grupo "Sem feature" recém-escolhido) abre a lista, as visitadas seguem por recência, as nunca visitadas na ordem do
// grafo, e os grupos "Sem feature" (isTail) fecham a lista na mesma regra.
export function orderByMru(
  keys: string[],
  order: string[],
  current: string | null,
  isTail: (key: string) => boolean = () => false,
): string[] {
  const exists = new Set(keys)
  const recent = (current ? touchFeatureMru(order, current) : order).filter((k) => exists.has(k))
  const rank = new Map(recent.map((k, i) => [k, i]))
  const byRank = (list: string[]) =>
    [...list].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity))
  // O atual abre a lista mesmo sendo um grupo "Sem feature": senão o toque rápido
  // (que vai para a 2ª) pularia de volta para outra feature em vez da anterior.
  const head = current && exists.has(current) ? [current] : []
  const rest = keys.filter((k) => k !== current)
  return [...head, ...byRank(rest.filter((k) => !isTail(k))), ...byRank(rest.filter(isTail))]
}

function readPersisted(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PERSIST_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

interface FeatureMruState {
  order: string[]
  touch: (key: string) => void
}

export const useFeatureMruStore = create<FeatureMruState>((set, get) => ({
  order: readPersisted(),
  touch: (key) => {
    if (get().order[0] === key) return
    const order = touchFeatureMru(get().order, key)
    set({ order })
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify(order))
    } catch {
      // localStorage indisponível: a ordem vale só nesta janela.
    }
  },
}))
