import { create } from 'zustand'

// Sessões focadas, da mais recente pra mais antiga (ccSessionId). Alimenta o
// session.back (Alt+Q): voltar pra onde você estava antes de pular pela fila.
// Só memória — sobreviver a reinício não vale uma migration.
const MAX_MRU = 20

export function touchMru(order: string[], ccSessionId: string, max = MAX_MRU): string[] {
  return [ccSessionId, ...order.filter((id) => id !== ccSessionId)].slice(0, max)
}

export function mruBackTarget(
  order: string[],
  currentCc: string | null,
  liveCcs: Set<string>,
): string | null {
  return order.find((id) => id !== currentCc && liveCcs.has(id)) ?? null
}

interface SessionMruState {
  order: string[]
  touch: (ccSessionId: string) => void
}

export const useSessionMruStore = create<SessionMruState>((set, get) => ({
  order: [],
  touch: (ccSessionId) => {
    if (get().order[0] === ccSessionId) return
    set({ order: touchMru(get().order, ccSessionId) })
  },
}))
