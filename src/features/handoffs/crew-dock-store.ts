import { create } from 'zustand'

// Estado do Crew Dock. Persistência leve só de `collapsed` e `width` (mesmo
// padrão do files-store: localStorage no renderer, sem IPC/DB). Abrir é decisão
// do usuário — clique ou Ctrl+J. O dock NÃO se abre sozinho: 340px de painel
// aparecendo por cima da leitura é interrupção grande demais pro aviso que ele
// carrega, e a trilha de 40px já pulsa com quem espera (ver CrewDock).
const PERSIST_KEY = 'cm:crew-dock'
const DEFAULT_WIDTH = 340
const MIN_WIDTH = 240
const MAX_WIDTH = 560

// Trilha colapsada: só os dots de status cabem aqui.
export const RAIL_WIDTH = 40

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)))
}

interface Persisted {
  collapsed: boolean
  width: number
}

function readPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return { collapsed: true, width: DEFAULT_WIDTH }
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      // Colapsado por padrão: o dock é periferia, não área de trabalho.
      collapsed: parsed.collapsed ?? true,
      width: clampWidth(typeof parsed.width === 'number' ? parsed.width : DEFAULT_WIDTH),
    }
  } catch {
    return { collapsed: true, width: DEFAULT_WIDTH }
  }
}

function writePersisted(p: Persisted): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(p))
  } catch {
    // localStorage indisponível — estado segue só em memória.
  }
}

interface CrewDockState {
  // Preferência manual persistida.
  collapsed: boolean
  width: number

  // Card sob o cursor de teclado (id do handoff). Vive aqui, e não no painel,
  // porque o Ctrl+J chega pelo AppShell — fora da árvore do dock.
  focusedId: string | null
  // Handoff aberto no quick look (CrewPeek). null = nenhum overlay.
  peekId: string | null
  // Nonce do pedido de foco: o AppShell incrementa, o dock (já expandido e
  // renderizado) reage focando o card. Um id não serviria — pedir foco duas
  // vezes pro mesmo card não mudaria o valor e o efeito não rodaria.
  focusNonce: number

  expand: () => void
  collapse: () => void
  toggle: () => void
  setWidth: (width: number) => void

  setFocusedId: (id: string | null) => void
  // Ctrl+J: abre o dock (se preciso) e pede o foco pro card corrente.
  requestFocus: () => void
  openPeek: (id: string) => void
  closePeek: () => void
}

const persisted = readPersisted()

export const useCrewDockStore = create<CrewDockState>((set, get) => ({
  collapsed: persisted.collapsed,
  width: persisted.width,
  focusedId: null,
  peekId: null,
  focusNonce: 0,

  expand: () => {
    writePersisted({ collapsed: false, width: get().width })
    set({ collapsed: false })
  },

  collapse: () => {
    writePersisted({ collapsed: true, width: get().width })
    set({ collapsed: true })
  },

  toggle: () => {
    if (get().collapsed) get().expand()
    else get().collapse()
  },

  setWidth: (width) => {
    const next = clampWidth(width)
    writePersisted({ collapsed: get().collapsed, width: next })
    set({ width: next })
  },

  setFocusedId: (focusedId) => {
    if (get().focusedId !== focusedId) set({ focusedId })
  },

  requestFocus: () => {
    // Colapsado não tem card no DOM pra receber foco — expande antes de pedir.
    // É por aqui que o Ctrl+J continua entrando no dock com uma tecla só.
    if (get().collapsed) get().expand()
    set({ focusNonce: get().focusNonce + 1 })
  },

  openPeek: (peekId) => set({ peekId, focusedId: peekId }),

  closePeek: () => set({ peekId: null }),
}))
