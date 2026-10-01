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

// O que o quick look mostra: a conversa renderizada (default) ou o terminal cru
// da filha. Os dois modos vivem NA JANELA — abrir o terminal não promove a filha
// a aba (ver crewTerminalTarget). Não é persistido: cada abertura declara o modo
// que pediu, senão um "espiar" herdaria o terminal de meia hora atrás.
export type CrewPeekMode = 'chat' | 'terminal'

// O que o quick look mostra: a filha de um handoff do dock, ou qualquer sessão
// viva (cartão do mapa de sessões). O id é handoffs.id ou sessions.id.
export interface PeekTarget {
  kind: 'session' | 'handoff'
  id: string
}

// De onde o peek abriu. 'map' é o lift: painel grande sobre o mapa esmaecido,
// com a faixa de troca entre as sessões do mesmo agrupamento.
export type PeekOrigin = 'dock' | 'map'

export interface SessionPeekOptions {
  origin?: PeekOrigin
  // sessions.id da faixa de troca, na ordem do mapa (ver liftGroup).
  siblings?: string[]
}

// Sessão aberta no peek pelo mapa (peekId é null nesse caso).
export function peekedSessionId(peek: PeekTarget | null): string | null {
  return peek?.kind === 'session' ? peek.id : null
}

interface CrewDockState {
  // Preferência manual persistida.
  collapsed: boolean
  width: number

  // Card sob o cursor de teclado (id do handoff). Vive aqui, e não no painel,
  // porque o Ctrl+J chega pelo AppShell — fora da árvore do dock.
  focusedId: string | null
  // Alvo aberto no quick look (CrewPeek). null = nenhum overlay.
  peekTarget: PeekTarget | null
  // Espelho do alvo quando ele é um handoff (o que dock, HUD de atenção e
  // navegação por relações perguntam). null também com peek de sessão aberto.
  peekId: string | null
  peekMode: CrewPeekMode
  peekOrigin: PeekOrigin
  peekSiblings: string[]
  // Lido pelo CrewPeek ao desmontar: false quando quem fechou já levou o foco pra
  // outro lugar (pulo da fila de atenção) e devolvê-lo à origem desfaria o pulo.
  peekRestoreFocus: boolean
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
  openPeek: (id: string, mode?: CrewPeekMode, opts?: SessionPeekOptions) => void
  openSessionPeek: (sessionId: string, mode?: CrewPeekMode, opts?: SessionPeekOptions) => void
  setPeekMode: (mode: CrewPeekMode) => void
  closePeek: (opts?: { restoreFocus?: boolean }) => void
}

const persisted = readPersisted()

export const useCrewDockStore = create<CrewDockState>((set, get) => ({
  collapsed: persisted.collapsed,
  width: persisted.width,
  focusedId: null,
  peekTarget: null,
  peekId: null,
  peekMode: 'chat',
  peekOrigin: 'dock',
  peekSiblings: [],
  peekRestoreFocus: true,
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

  // O mapa também abre o peek de handoff (filha do dock): com origin 'map' ele é
  // o lift, com as mesmas regras do resto do mapa (não navega, assume a PTY).
  //
  // Sem origin explícito (fila de atenção, Alt+Q, navegação por relações) com o
  // lift aberto, o peek CONTINUA lift: virar peek do dock faria o "Ver o terminal"
  // levar pra aba, e no mapa só o "Abrir na aba" navega. Sem faixa — as irmãs
  // eram da sessão anterior.
  openPeek: (peekId, peekMode = 'chat', opts) => {
    const inLift = get().peekTarget !== null && get().peekOrigin === 'map'
    set({
      peekTarget: { kind: 'handoff', id: peekId },
      peekId,
      peekMode,
      focusedId: peekId,
      peekOrigin: opts?.origin ?? (inLift ? 'map' : 'dock'),
      peekSiblings: opts?.siblings ?? [],
    })
  },

  openSessionPeek: (sessionId, peekMode = 'chat', opts) =>
    set({
      peekTarget: { kind: 'session', id: sessionId },
      peekId: null,
      peekMode,
      peekOrigin: opts?.origin ?? 'dock',
      peekSiblings: opts?.siblings ?? [],
    }),

  setPeekMode: (peekMode) => set({ peekMode }),

  closePeek: (opts) =>
    set({
      peekTarget: null,
      peekId: null,
      peekMode: 'chat',
      peekOrigin: 'dock',
      peekSiblings: [],
      peekRestoreFocus: opts?.restoreFocus !== false,
    }),
}))
