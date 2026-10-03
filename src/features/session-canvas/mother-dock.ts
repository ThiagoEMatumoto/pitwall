import { create } from 'zustand'
import type { SessionGraphNode } from '../../../shared/types/session-graph'

// O painel da mãe: a mãe da feature em foco num painel grande à esquerda do
// mapa, com o terminal real (fora do transform do ReactFlow: legível em qualquer
// zoom). Troca sozinho quando a feature em foco muda; "Fixar esta" trava a mãe
// atual até soltar. Preferência local do renderer (mesmo padrão do
// crew-dock-store): a fixada, se o painel está ligado e a fração da linha que ele
// ocupa. Não vai pro banco: é o arranjo da janela de quem usa.
const PERSIST_KEY = 'cm:mother-dock'
// Antes da 1ª medição da linha (um frame): a largura da antiga coluna.
export const DOCK_DEFAULT_W = 520
// Abaixo disto o terminal não chega a ~100 colunas a 14px.
export const DOCK_MIN_W = 360
// Fração da linha (painel + mapa): o painel é a peça principal, o mapa o contexto.
export const PANEL_SHARE = 0.55
export const PANEL_MIN_SHARE = 0.3
export const PANEL_MAX_SHARE = 0.75

export function clampShare(share: number): number {
  if (!Number.isFinite(share)) return PANEL_SHARE
  return Math.min(PANEL_MAX_SHARE, Math.max(PANEL_MIN_SHARE, Math.round(share * 1000) / 1000))
}

// O mapa ao lado nunca fica menor que isto: a fração salva numa janela larga não
// pode espremer o mapa num filete numa janela menor.
export const MAP_MIN_W = 480

// Largura do painel numa linha de `rowWidth` px (painel + mapa). Linha estreita
// demais para os dois mínimos: o painel fica com 40% dela.
export function panelWidth(share: number, rowWidth: number | null): number {
  if (rowWidth === null || !Number.isFinite(rowWidth) || rowWidth <= 0) return DOCK_DEFAULT_W
  const room = Math.max(rowWidth - MAP_MIN_W, Math.round(rowWidth * 0.4))
  return Math.min(Math.max(Math.round(rowWidth * clampShare(share)), DOCK_MIN_W), room)
}

// A largura que o separador soltou, como fração da linha (o que persiste).
export function shareOfWidth(width: number, rowWidth: number | null): number {
  if (rowWidth === null || !Number.isFinite(rowWidth) || rowWidth <= 0) return PANEL_SHARE
  return clampShare(width / rowWidth)
}

export type DockMode = 'focus' | 'off'

// Quem o painel mostra: a fixada (trava), senão a mãe da feature em foco.
// 'off' (escondido pelo atalho) esconde as duas; a trava fica guardada.
// A feature em foco sem mãe (motherOfFocus strict = null) não fecha o painel: ele
// fica na última mãe que mostrou enquanto ela segue em uso. Fechar e reabrir a
// cada clique reenquadrava a câmera e remontava o xterm.
export function keepLastMother(
  next: string | null,
  last: string | null,
  inUse: ReadonlySet<string>,
): string | null {
  return next ?? (last && inUse.has(last) ? last : null)
}

export function effectiveMotherId(args: {
  pinnedId: string | null
  mode: DockMode
  autoId: string | null
}): string | null {
  if (args.mode === 'off') return null
  return args.pinnedId ?? args.autoId
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
  // strict: a feature em foco sem mãe dá null (não escolhe a mãe de outra feature
  // por ela; o painel fica na que já mostrava, keepLastMother). Sem strict, cai
  // na mais recente do mapa.
  opts: { strict?: boolean } = {},
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
  if (opts.strict && focus.featureId && pool.length === 0) return null
  const best = [...(pool.length ? pool : tops)].sort(
    (a, b) =>
      (b.childCount ?? 0) - (a.childCount ?? 0) ||
      (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
  )[0]
  return best?.sessionId ?? null
}

interface Persisted {
  pinnedId: string | null
  mode: DockMode
  share: number
}

const DEFAULTS: Persisted = { pinnedId: null, mode: 'focus', share: PANEL_SHARE }

// O `width` em px da coluna antiga é ignorado: o painel nasce com a fração padrão.
function readPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return DEFAULTS
    const p = JSON.parse(raw) as Partial<Persisted>
    return {
      pinnedId: typeof p.pinnedId === 'string' ? p.pinnedId : null,
      mode: p.mode === 'off' ? 'off' : 'focus',
      share: clampShare(typeof p.share === 'number' ? p.share : PANEL_SHARE),
    }
  } catch {
    return DEFAULTS
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
  // Quem o painel está desenhando AGORA (escrito pelo MotherDock depois do
  // debounce da troca): o cartão dela mostra "está no painel" e o enquadrar a
  // deixa de fora. null = painel fechado.
  shownId: string | null
  setShown: (sessionId: string | null) => void
  // Nonce: o atalho pede foco no xterm do painel sem mudar o id.
  // focusPending é o pedido em si, de uso único (takeFocus): sem ele, todo
  // remount do painel com nonce > 0 roubava o foco do mapa.
  focusNonce: number
  focusPending: boolean
  takeFocus: () => boolean
  // Trava a mãe atual no painel (e mostra o painel, se escondido).
  pin: (sessionId: string) => void
  unpin: () => void
  togglePanel: () => void
  hide: () => void
  setShare: (share: number) => void
  requestFocus: () => void
  // Atalho apertado fora do mapa (Terminais, outra área): o AppShell abre o mapa e
  // deixa o pedido aqui; o mapa, ao montar, o consome. sessionId = a aba em foco.
  pendingFromOutside: { sessionId: string | null } | null
  requestFromOutside: (sessionId: string | null) => void
  takePendingFromOutside: () => { sessionId: string | null } | null
  // Bastão: a trava segue para a sucessora.
  follow: (edges: ReadonlyArray<EdgeLike>, inUse: ReadonlySet<string>) => void
}

const initial = readPersisted()

export const useMotherDockStore = create<MotherDockState>((set, get) => {
  const save = (patch: Partial<Persisted>) => {
    set(patch)
    const { pinnedId, mode, share } = get()
    writePersisted({ pinnedId, mode, share })
  }
  return {
    ...initial,
    shownId: null,
    setShown: (sessionId) => {
      if (get().shownId !== sessionId) set({ shownId: sessionId })
    },
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
    pin: (sessionId) => save({ pinnedId: sessionId, mode: 'focus' }),
    unpin: () => save({ pinnedId: null }),
    togglePanel: () => save({ mode: get().mode === 'off' ? 'focus' : 'off' }),
    hide: () => save({ mode: 'off' }),
    setShare: (share) => save({ share: clampShare(share) }),
    requestFocus: () => set((s) => ({ focusNonce: s.focusNonce + 1, focusPending: true })),
    follow: (edges, inUse) => {
      const { pinnedId } = get()
      if (!pinnedId) return
      const next = followBaton(pinnedId, edges, inUse)
      if (next !== pinnedId) save({ pinnedId: next })
    },
  }
})
