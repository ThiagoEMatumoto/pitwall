import { create } from 'zustand'
import type { SessionGraphNode } from '../../../shared/types/session-graph'

// "Fixar mãe" (o Dock do Maestri): a mãe presa numa coluna de altura total à
// esquerda do mapa, com o terminal real e o composer. Preferência local do
// renderer (mesmo padrão do crew-dock-store): qual sessão está fixada e a
// largura da coluna. Não vai pro banco: é o arranjo da janela de quem usa.
const PERSIST_KEY = 'cm:mother-dock'
export const DOCK_DEFAULT_W = 520
export const DOCK_MIN_W = 360
export const DOCK_MAX_W = 960

export function clampDockWidth(width: number): number {
  if (!Number.isFinite(width)) return DOCK_DEFAULT_W
  return Math.min(DOCK_MAX_W, Math.max(DOCK_MIN_W, Math.round(width)))
}

// O mapa ao lado nunca fica menor que isto: a largura salva vem de outra janela
// (monitor grande) e não pode espremer o mapa num filete numa janela menor.
export const MAP_MIN_W = 480

// Largura que a coluna ocupa de fato numa linha de `rowWidth` px (coluna + mapa).
// Linha estreita demais para os dois mínimos: a coluna fica com até 40% dela.
export function fitDockToRow(width: number, rowWidth: number | null): number {
  if (rowWidth === null || !Number.isFinite(rowWidth) || rowWidth <= 0) return width
  const room = Math.max(rowWidth - MAP_MIN_W, Math.round(rowWidth * 0.4))
  return Math.min(width, room)
}

interface EdgeLike {
  kind: string
  from?: string
  to?: string
}

// A mãe passou o bastão: a coluna vai para a sucessora (a última da cadeia que
// ainda está em uso). Sem bastão, ou com a sucessora fora de uso, fica onde está.
export function followBaton(
  pinnedId: string,
  edges: ReadonlyArray<EdgeLike>,
  inUse: ReadonlySet<string>,
): string {
  const next = new Map<string, string>()
  for (const e of edges) if (e.kind === 'baton' && e.from && e.to) next.set(e.from, e.to)
  let cur = pinnedId
  const seen = new Set([cur])
  for (let to = next.get(cur); to && !seen.has(to); to = next.get(cur)) {
    seen.add(to)
    if (inUse.has(to)) cur = to
    else break
  }
  return cur
}

// Qual mãe o atalho abre: a da sessão selecionada (ela mesma, se for mãe; a mãe
// do fio de handoff, se for filha), senão a da feature em foco, senão a mais
// recente do mapa (estas duas, só entre as mães do topo). Só mães em uso.
export function motherOfFocus(
  nodes: ReadonlyArray<SessionGraphNode>,
  edges: ReadonlyArray<EdgeLike>,
  inUse: ReadonlySet<string>,
  focus: { sessionId?: string | null; featureId?: string | null },
): string | null {
  const mothers = nodes.filter((n) => n.isMother && inUse.has(n.sessionId))
  const byId = new Map(mothers.map((n) => [n.sessionId, n]))
  if (focus.sessionId) {
    if (byId.has(focus.sessionId)) return focus.sessionId
    const up = edges.find((e) => e.kind === 'handoff' && e.to === focus.sessionId)
    if (up?.from && byId.has(up.from)) return up.from
    const self = nodes.find((n) => n.sessionId === focus.sessionId)
    if (self?.featureId) focus = { featureId: self.featureId }
  }
  // Sem seleção, só a mãe do TOPO (a que o mapa destaca: graphToFlow.prominentMother):
  // uma intermediária (filha que delegou netas) com mais filhas não pode roubar o
  // enquadrar nem o atalho da mãe grande.
  const hasMotherOnMap = (id: string) =>
    edges.some((e) => e.kind === 'handoff' && e.to === id && !!e.from && inUse.has(e.from))
  const tops = mothers.filter((n) => !hasMotherOnMap(n.sessionId))
  const pool = focus.featureId ? tops.filter((n) => n.featureId === focus.featureId) : tops
  const best = [...(pool.length ? pool : tops)].sort(
    (a, b) =>
      (b.childCount ?? 0) - (a.childCount ?? 0) ||
      (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
  )[0]
  return best?.sessionId ?? null
}

interface Persisted {
  pinnedId: string | null
  width: number
}

function readPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return { pinnedId: null, width: DOCK_DEFAULT_W }
    const p = JSON.parse(raw) as Partial<Persisted>
    return {
      pinnedId: typeof p.pinnedId === 'string' ? p.pinnedId : null,
      width: clampDockWidth(typeof p.width === 'number' ? p.width : DOCK_DEFAULT_W),
    }
  } catch {
    return { pinnedId: null, width: DOCK_DEFAULT_W }
  }
}

function writePersisted(p: Persisted): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(p))
  } catch {
    // localStorage indisponível: o arranjo vale só nesta janela.
  }
}

interface MotherDockState extends Persisted {
  // Nonce: o atalho pede foco no xterm da coluna (já fixada) sem mudar o id.
  // focusPending é o pedido em si, de uso único (takeFocus): sem ele, todo
  // remount da coluna com nonce > 0 roubava o foco do mapa.
  focusNonce: number
  focusPending: boolean
  takeFocus: () => boolean
  pin: (sessionId: string) => void
  unpin: () => void
  setWidth: (width: number) => void
  requestFocus: () => void
  // Atalho apertado fora do mapa (Terminais, outra área): o AppShell abre o mapa e
  // deixa o pedido aqui; o mapa, ao montar, o consome. sessionId = a aba em foco.
  pendingFromOutside: { sessionId: string | null } | null
  requestFromOutside: (sessionId: string | null) => void
  takePendingFromOutside: () => { sessionId: string | null } | null
  // Bastão: a coluna segue para a sucessora.
  follow: (edges: ReadonlyArray<EdgeLike>, inUse: ReadonlySet<string>) => void
}

const initial = readPersisted()

export const useMotherDockStore = create<MotherDockState>((set, get) => {
  const save = (patch: Partial<Persisted>) => {
    set(patch)
    const { pinnedId, width } = get()
    writePersisted({ pinnedId, width })
  }
  return {
    ...initial,
    focusNonce: 0,
    focusPending: false,
    takeFocus: () => {
      if (!get().focusPending) return false
      set({ focusPending: false })
      return true
    },
    pendingFromOutside: null,
    requestFromOutside: (sessionId) => set({ pendingFromOutside: { sessionId } }),
    takePendingFromOutside: () => {
      const p = get().pendingFromOutside
      if (p) set({ pendingFromOutside: null })
      return p
    },
    pin: (sessionId) => {
      save({ pinnedId: sessionId })
      get().requestFocus()
    },
    unpin: () => save({ pinnedId: null }),
    setWidth: (width) => save({ width: clampDockWidth(width) }),
    requestFocus: () => set((s) => ({ focusNonce: s.focusNonce + 1, focusPending: true })),
    follow: (edges, inUse) => {
      const { pinnedId } = get()
      if (!pinnedId) return
      const next = followBaton(pinnedId, edges, inUse)
      if (next !== pinnedId) save({ pinnedId: next })
    },
  }
})
