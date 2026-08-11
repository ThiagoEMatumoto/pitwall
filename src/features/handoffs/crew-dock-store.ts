import { create } from 'zustand'

// Estado do Crew Dock. Persistência leve só de `collapsed` e `width` (mesmo
// padrão do files-store: localStorage no renderer, sem IPC/DB). O auto-reveal é
// volátil de propósito — ele reflete o AGORA das filhas, não uma preferência.
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
  // Volátil: alguma filha está esperando e o dock se abriu sozinho.
  autoRevealed: boolean
  // Volátil: o usuário recolheu DURANTE um auto-reveal — não reabrir até a fila
  // de espera esvaziar (senão o dock briga com quem acabou de fechá-lo).
  muted: boolean

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
  // Chamado a cada mudança do número de filhas aguardando.
  syncAttention: (hasAttention: boolean) => void

  setFocusedId: (id: string | null) => void
  // Ctrl+J: abre o dock (se preciso) e pede o foco pro card corrente.
  requestFocus: () => void
  openPeek: (id: string) => void
  closePeek: () => void
}

const persisted = readPersisted()

// Derivado: aberto se o usuário deixou aberto OU se o auto-reveal disparou.
export function dockExpanded(s: { collapsed: boolean; autoRevealed: boolean }): boolean {
  return !s.collapsed || s.autoRevealed
}

export const useCrewDockStore = create<CrewDockState>((set, get) => ({
  collapsed: persisted.collapsed,
  width: persisted.width,
  autoRevealed: false,
  muted: false,
  focusedId: null,
  peekId: null,
  focusNonce: 0,

  expand: () => {
    writePersisted({ collapsed: false, width: get().width })
    set({ collapsed: false, muted: false })
  },

  collapse: () => {
    // Recolher com filha esperando = silenciar até a espera acabar.
    const muted = get().autoRevealed
    writePersisted({ collapsed: true, width: get().width })
    set({ collapsed: true, autoRevealed: false, muted })
  },

  toggle: () => {
    if (dockExpanded(get())) get().collapse()
    else get().expand()
  },

  setWidth: (width) => {
    const next = clampWidth(width)
    writePersisted({ collapsed: get().collapsed, width: next })
    set({ width: next })
  },

  syncAttention: (hasAttention) => {
    const { autoRevealed, muted } = get()
    if (hasAttention) {
      if (!autoRevealed && !muted) set({ autoRevealed: true })
      return
    }
    // Ninguém mais esperando: recolhe o que o auto-reveal abriu e rearma o gatilho.
    if (autoRevealed || muted) set({ autoRevealed: false, muted: false })
  },

  setFocusedId: (focusedId) => {
    if (get().focusedId !== focusedId) set({ focusedId })
  },

  requestFocus: () => {
    // Colapsado não tem card no DOM pra receber foco — expande antes de pedir.
    if (!dockExpanded(get())) get().expand()
    set({ focusNonce: get().focusNonce + 1 })
  },

  openPeek: (peekId) => set({ peekId, focusedId: peekId }),

  closePeek: () => set({ peekId: null }),
}))
