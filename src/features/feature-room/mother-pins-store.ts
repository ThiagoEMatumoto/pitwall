import { create } from 'zustand'

// Mães fixadas no nível "Todas as mães". Preferência por pessoa e por máquina,
// no mesmo padrão do pin do MotherDock (localStorage com try/catch): sem storage,
// o pin vale só nesta janela. Guarda pinKey (ccSessionId ?? sessionId), que
// sobrevive ao resume.
const KEY = 'pitwall.room.mother-pins'

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    const v: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function write(order: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(order))
  } catch {
    // storage indisponível: o pin vale só nesta janela.
  }
}

interface MotherPinsState {
  order: string[]
  toggle: (key: string) => void
  // alive = pinKey dos nós do grafo que NÃO estão ended (não os de allMothers):
  // uma mãe momentaneamente fora de inUse não perde o pin.
  prune: (alive: ReadonlySet<string>) => void
}

export const useMotherPins = create<MotherPinsState>((set, get) => ({
  order: read(),
  toggle: (key) => {
    const cur = get().order
    const order = cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key]
    write(order)
    set({ order })
  },
  prune: (alive) => {
    // Vazio = grafo ainda não carregou; podar aqui apagaria todos os pins. Sem
    // nenhuma sessão viva de fato, manter os pins é inofensivo: o próximo prune
    // com grafo os poda.
    if (alive.size === 0) return
    const cur = get().order
    const order = cur.filter((k) => alive.has(k))
    if (order.length === cur.length) return
    write(order)
    set({ order })
  },
}))
