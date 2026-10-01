// PURO: estado de exibição dos cartões de sessão no mapa e as regras dele.
//   collapsed — identidade + estado (o cartão de antes, mais baixo)
//   open      — + saída ao vivo, barra de prompt e ações de atenção (default)
//   terminal  — o xterm real da sessão no lugar do cartão
// Toda transição devolve o mapa novo E o que mudou, pra gravar só a diferença.
import type { CanvasCardView, CardViewState } from '../../../shared/types/canvas'

export const DEFAULT_VIEW: CardViewState = 'open'
// Abaixo disto o terminal do cartão fica pequeno demais pra ler/clicar: volta a 'open'.
export const TERMINAL_MIN_ZOOM = 0.85

export type ViewMap = Readonly<Record<string, CardViewState>>

export interface ViewChange {
  next: ViewMap
  changed: CanvasCardView[]
}

export function viewOf(views: ViewMap, sessionId: string): CardViewState {
  return views[sessionId] ?? DEFAULT_VIEW
}

function apply(views: ViewMap, updates: Array<[string, CardViewState]>): ViewChange {
  const next: Record<string, CardViewState> = { ...views }
  const changed: CanvasCardView[] = []
  for (const [sessionId, viewState] of updates) {
    if (viewOf(next, sessionId) === viewState) continue
    next[sessionId] = viewState
    changed.push({ sessionId, viewState })
  }
  return { next: changed.length ? next : views, changed }
}

export function terminalOf(views: ViewMap): string | null {
  return Object.keys(views).find((id) => views[id] === 'terminal') ?? null
}

// Do banco: no máximo um terminal (o primeiro vence; os outros abrem e gravam).
export function hydrateViews(rows: CanvasCardView[]): ViewChange {
  const base: Record<string, CardViewState> = {}
  const demote: Array<[string, CardViewState]> = []
  let terminal: string | null = null
  for (const r of rows) {
    if (r.viewState === 'terminal') {
      if (terminal) {
        base[r.sessionId] = 'terminal'
        demote.push([r.sessionId, 'open'])
        continue
      }
      terminal = r.sessionId
    }
    base[r.sessionId] = r.viewState
  }
  return apply(base, demote)
}

// Chevron / duplo clique no cabeçalho: recolhido ⇄ aberto (do terminal, recolhe).
export function toggleCollapsed(views: ViewMap, sessionId: string): ViewChange {
  return apply(views, [
    [sessionId, viewOf(views, sessionId) === 'collapsed' ? 'open' : 'collapsed'],
  ])
}

// "Abrir todos" abre os recolhidos; o terminal em uso fica como está.
export function openAll(views: ViewMap, ids: string[]): ViewChange {
  return apply(
    views,
    ids.filter((id) => viewOf(views, id) === 'collapsed').map((id) => [id, 'open']),
  )
}

export function collapseAll(views: ViewMap, ids: string[]): ViewChange {
  return apply(
    views,
    ids.map((id) => [id, 'collapsed']),
  )
}

// Um terminal por vez: entrar num devolve o anterior a 'open'.
export function enterTerminal(views: ViewMap, sessionId: string): ViewChange {
  const previous = terminalOf(views)
  const updates: Array<[string, CardViewState]> = []
  if (previous && previous !== sessionId) updates.push([previous, 'open'])
  updates.push([sessionId, 'terminal'])
  return apply(views, updates)
}

export function leaveTerminal(views: ViewMap, sessionId: string): ViewChange {
  return viewOf(views, sessionId) === 'terminal'
    ? apply(views, [[sessionId, 'open']])
    : { next: views, changed: [] }
}

// Linhagem: a sucessora do bastão (ou a mesma conversa retomada numa PTY nova)
// herda o recolhido/aberto da antecessora, em vez de nascer no default. Só quem
// ainda não tem estado próprio; terminal não se herda (um por vez, e a PTY é outra).
// `lineage` = [sucessora, antecessora].
export function inheritViews(views: ViewMap, lineage: Array<[string, string]>): ViewChange {
  const updates: Array<[string, CardViewState]> = []
  for (const [next, prev] of lineage) {
    if (views[next] !== undefined || views[prev] === undefined) continue
    updates.push([next, views[prev] === 'terminal' ? 'open' : views[prev]])
  }
  return apply(views, updates)
}

// [sucessora, antecessora] das sessões em uso: o bastão (fio baton) e a mesma
// conversa do claude (ccSessionId) que ganhou outra sessions.id ao ser retomada.
export function viewLineage(
  nodes: Array<{ sessionId: string; ccSessionId: string | null }>,
  edges: Array<{ kind: string; from?: string; to?: string }>,
  inUse: ReadonlySet<string>,
): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const e of edges) {
    if (e.kind === 'baton' && e.from && e.to && inUse.has(e.to)) out.push([e.to, e.from])
  }
  const byCc = new Map<string, string[]>()
  for (const n of nodes) {
    if (!n.ccSessionId) continue
    byCc.set(n.ccSessionId, [...(byCc.get(n.ccSessionId) ?? []), n.sessionId])
  }
  for (const ids of byCc.values()) {
    const current = ids.filter((id) => inUse.has(id))
    if (current.length !== 1) continue
    for (const id of ids) if (id !== current[0]) out.push([current[0], id])
  }
  return out
}

// Regra aba × cartão (a mesma do CrewPeek): dois xterms na MESMA PTY brigariam
// pelo resize. Sessão com aba aberta → "Interagir" leva até a aba; sem PTY viva
// não há o que montar.
export type TerminalHost = 'card' | 'tab' | 'none'

export function terminalHostFor(input: { live: boolean; hasPane: boolean }): TerminalHost {
  if (!input.live) return 'none'
  return input.hasPane ? 'tab' : 'card'
}

// O cartão em modo terminal cede quando a mesma sessão ganha outro xterm (aba
// aberta, peek em modo terminal), quando a PTY morre ou quando o zoom afasta.
export function mustLeaveTerminal(input: {
  live: boolean
  hasPane: boolean
  peekedInTerminal: boolean
  zoom: number
}): boolean {
  return !input.live || input.hasPane || input.peekedInTerminal || input.zoom < TERMINAL_MIN_ZOOM
}
