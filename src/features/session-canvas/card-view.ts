// PURO: estado de exibição dos cartões de sessão no mapa e as regras dele.
//   collapsed — identidade + estado (o cartão de antes, mais baixo)
//   open      — + saída ao vivo, barra de prompt e ações de atenção (default)
// O antigo 'terminal' (xterm no lugar do cartão) não existe mais: o terminal do
// mapa abre na modal (CrewPeek em size lift). Linhas 'terminal' do banco são
// rebaixadas a 'open' no hydrate.
// Toda transição devolve o mapa novo E o que mudou, pra gravar só a diferença.
import type { CanvasCardView, CardViewState } from '../../../shared/types/canvas'

export const DEFAULT_VIEW: CardViewState = 'open'

export type ViewMap = Readonly<Record<string, CardViewState>>

export interface ViewChange {
  next: ViewMap
  changed: CanvasCardView[]
}

export function viewOf(views: ViewMap, sessionId: string): CardViewState {
  const v = views[sessionId]
  return v === undefined || v === 'terminal' ? DEFAULT_VIEW : v
}

function apply(views: ViewMap, updates: Array<[string, CardViewState]>): ViewChange {
  const next: Record<string, CardViewState> = { ...views }
  const changed: CanvasCardView[] = []
  for (const [sessionId, viewState] of updates) {
    // Cru, não viewOf: o 'terminal' legado lê como 'open' mas precisa ser regravado.
    if ((next[sessionId] ?? DEFAULT_VIEW) === viewState) continue
    next[sessionId] = viewState
    changed.push({ sessionId, viewState })
  }
  return { next: changed.length ? next : views, changed }
}

// Do banco: o estado legado 'terminal' vira 'open' (e grava a correção).
export function hydrateViews(rows: CanvasCardView[]): ViewChange {
  const base: Record<string, CardViewState> = {}
  const demote: Array<[string, CardViewState]> = []
  for (const r of rows) {
    base[r.sessionId] = r.viewState
    if (r.viewState === 'terminal') demote.push([r.sessionId, 'open'])
  }
  return apply(base, demote)
}

// Chevron: recolhido ⇄ aberto.
export function toggleCollapsed(views: ViewMap, sessionId: string): ViewChange {
  return apply(views, [
    [sessionId, viewOf(views, sessionId) === 'collapsed' ? 'open' : 'collapsed'],
  ])
}

// "Abrir todos" abre os recolhidos.
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

// Linhagem: a sucessora do bastão (ou a mesma conversa retomada numa PTY nova)
// herda o recolhido/aberto da antecessora, em vez de nascer no default. Só quem
// ainda não tem estado próprio.
// `lineage` = [sucessora, antecessora].
export function inheritViews(views: ViewMap, lineage: Array<[string, string]>): ViewChange {
  const updates: Array<[string, CardViewState]> = []
  for (const [next, prev] of lineage) {
    if (views[next] !== undefined || views[prev] === undefined) continue
    updates.push([next, viewOf(views, prev)])
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

// Onde o terminal do mapa abre: sempre na modal (que assume a PTY mesmo com aba
// aberta — a aba mostra "Aberto no mapa", ver terminal-lease). Sem PTY viva não
// há o que montar. Nunca 'tab': navegar é só pelo "Abrir na aba".
export type TerminalHost = 'modal' | 'none'

// Sessão encerrada continua em liveSessions (status 'ended'): sem PTY a anexar.
export function terminalHostFor(live: { status: string } | undefined): TerminalHost {
  return live && live.status !== 'ended' ? 'modal' : 'none'
}

// Faixa de troca da modal (Alt+, / Alt+.): as sessões em uso do mesmo
// agrupamento do mapa — hoje o projeto (a F2 troca pelo card da feature). Na
// ordem em que o mapa as empilha: repo, depois a atividade mais recente.
export function liftGroup(
  nodes: ReadonlyArray<{
    sessionId: string
    projectId: string | null
    repoLabel: string | null
    lastActivityAt: number | null
  }>,
  sessionId: string,
  inUse: ReadonlySet<string>,
): string[] {
  const self = nodes.find((n) => n.sessionId === sessionId)
  if (!self) return [sessionId]
  return nodes
    .filter((n) => n.projectId === self.projectId && (inUse.has(n.sessionId) || n === self))
    .sort(
      (a, b) =>
        (a.repoLabel ?? '').localeCompare(b.repoLabel ?? '') ||
        (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
    )
    .map((n) => n.sessionId)
}

// Próxima sessão da faixa (wrap nas pontas: a faixa é um carrossel curto).
export function stepLift(ids: string[], current: string, delta: number): string {
  const i = ids.indexOf(current)
  if (ids.length === 0 || i < 0) return current
  return ids[(i + delta + ids.length) % ids.length]
}

// Duplo clique no cartão abre o terminal na modal — mas não quando os cliques
// caíram num controle do header (chevron, chip da mãe, fan, lápis): cada botão
// já fez a sua ação, e o React Flow propagaria o dblclick até o nó.
export function doubleClickOpensTerminal(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true
  return !target.closest('button, a, input, textarea, select, [contenteditable="true"]')
}
