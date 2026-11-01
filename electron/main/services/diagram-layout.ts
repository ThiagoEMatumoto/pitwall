// Layout dos diagramas com ELK (layered + roteamento ortogonal). Só no main:
// o elk.bundled.js roda em Node sem Worker. A montagem dos elementos fica em
// shared/diagram-skeleton (síncrona, isomórfica); aqui só entra a parte async.
import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api'
import {
  buildElements,
  directionOf,
  elementsLayoutGraph,
  isAutoPlaced,
  isLayoutNode,
  skeletonLayoutGraph,
  type DiagramDirection,
  type DiagramLayoutOptions,
  type DiagramPatchOp,
  type DiagramSkeletonElement,
  type ExElement,
  type LayoutGraph,
  type LayoutResult,
  type Point,
} from '../../../shared/diagram-skeleton'
import { applyPatchOps, finalizePatchLayout } from '../../../shared/diagram-patch'

const elk = new ELK()

const LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  // BRANDES_KOEPF balanceado centraliza o pai no meio dos filhos (fan-out).
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  // Respeita a ordem de entrada do skeleton: layout estável entre patches.
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.spacing.nodeNode': '60',
  'elk.layered.spacing.nodeNodeBetweenLayers': '100',
  'elk.spacing.edgeNode': '30',
  // Default 10: a primeira dobra ficava a 10px do nó e a ponta da seta
  // (crowfoot, losango) sumia na curva. Casa com MIN_ARROWHEAD_STUB.
  'elk.layered.spacing.edgeNodeBetweenLayers': '32',
  'elk.spacing.edgeEdge': '20',
  'elk.spacing.edgeLabel': '8',
  'elk.spacing.componentComponent': '100',
  'elk.edgeLabels.placement': 'CENTER',
}

// Opções de espaçamento valem por nó no ELK: compound repete as da raiz.
const SPACING_OPTIONS = Object.fromEntries(
  Object.entries(LAYOUT_OPTIONS).filter(([k]) => k.startsWith('elk.spacing') || k.includes('.spacing.'))
)

const elkPadding = (p: { top: number; left: number; bottom: number; right: number }) =>
  `[top=${p.top},left=${p.left},bottom=${p.bottom},right=${p.right}]`

export async function runElkLayout(graph: LayoutGraph): Promise<LayoutResult> {
  // Aresta que volta na ordem dos nós (retreino, "não" → treino, fila →
  // worker) entra invertida no ELK e a rota é desvirada no fim. O cycle
  // breaking do ELK (inclusive MODEL_ORDER, com INCLUDE_CHILDREN) escolhia o
  // deploy como aresta de volta e o pipeline de ML saía Dados → Produção → Treino.
  const order = new Map(graph.nodes.map((n, i) => [n.id, i]))
  const isBack = (e: { source: string; target: string }) =>
    (order.get(e.source) ?? 0) > (order.get(e.target) ?? 0)
  const root: ElkNode = {
    id: '__root__',
    layoutOptions: {
      ...LAYOUT_OPTIONS,
      'elk.direction': graph.direction === 'TB' ? 'DOWN' : 'RIGHT',
      // Grupos/frames: um layout só pro grafo todo, arestas cruzando níveis.
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    },
    children: [],
    edges: graph.edges.map((e): ElkExtendedEdge => ({
      id: e.id,
      sources: [isBack(e) ? e.target : e.source],
      targets: [isBack(e) ? e.source : e.target],
      ...(e.label ? { labels: [{ id: `${e.id}__elk_label`, ...e.label }] } : {}),
    })),
  }
  const byId = new Map<string, ElkNode>([[root.id, root]])
  for (const c of graph.compounds ?? []) {
    byId.set(c.id, {
      id: c.id,
      layoutOptions: { ...SPACING_OPTIONS, 'elk.padding': elkPadding(c.padding) },
      children: [],
    })
  }
  const attach = (node: ElkNode, parent?: string) => {
    const host = (parent && byId.get(parent)) || root
    host.children!.push(node)
  }
  for (const c of graph.compounds ?? []) attach(byId.get(c.id)!, c.parent)
  for (const n of graph.nodes) {
    attach({ id: n.id, width: n.width, height: n.height }, n.parent)
  }

  const out = await elk.layout(root)
  // ELK devolve filhos relativos ao pai e rotas relativas ao container da aresta.
  const positions = new Map<string, { x: number; y: number }>()
  const offsets = new Map<string, { x: number; y: number }>([[root.id, { x: 0, y: 0 }]])
  const walk = (node: ElkNode, ox: number, oy: number) => {
    for (const child of node.children ?? []) {
      const at = { x: ox + (child.x ?? 0), y: oy + (child.y ?? 0) }
      positions.set(child.id, at)
      offsets.set(child.id, at)
      walk(child, at.x, at.y)
    }
  }
  walk(out, 0, 0)
  const routes = new Map<string, Point[]>()
  const collectEdges = (node: ElkNode) => {
    for (const edge of node.edges ?? []) {
      const section = edge.sections?.[0]
      if (!section) continue
      const container = (edge as { container?: string }).container ?? node.id
      const o = offsets.get(container) ?? { x: 0, y: 0 }
      const abs = (p: { x: number; y: number }): Point => [p.x + o.x, p.y + o.y]
      routes.set(edge.id, [
        abs(section.startPoint),
        ...(section.bendPoints ?? []).map(abs),
        abs(section.endPoint),
      ])
    }
    for (const child of node.children ?? []) collectEdges(child)
  }
  collectEdges(out)
  for (const e of graph.edges) {
    const route = routes.get(e.id)
    if (route && isBack(e)) routes.set(e.id, [...route].reverse())
  }
  return { positions, routes }
}

/** Skeleton → elementos Excalidraw com layout ELK. */
export async function skeletonToElements(
  skeleton: DiagramSkeletonElement[],
  options: DiagramLayoutOptions = {},
): Promise<unknown[]> {
  const direction = options.direction ?? 'LR'
  const layout = await runElkLayout(skeletonLayoutGraph(skeleton, direction))
  return buildElements(skeleton, layout, { ...options, direction })
}

/** Direção gravada nos nós auto da cena (a do último layout); LR se nenhum. */
function sceneDirection(elements: unknown[]): DiagramDirection {
  for (const el of elements as ExElement[]) {
    if (!isLayoutNode(el) || !isAutoPlaced(el)) continue
    const dir = directionOf(el)
    if (dir) return dir
  }
  return 'LR'
}

/**
 * Patch incremental. layout "auto" (default): ELK roda no grafo inteiro, mas
 * só nós com customData.pitwall.auto=true se movem; pinados ficam e nenhum nó
 * auto é posto em cima deles (finalizePatchLayout). "keep":
 * nada se move, só as setas tocadas são reroteadas.
 */
export async function applyPatch(
  elements: unknown[],
  ops: DiagramPatchOp[],
  options: DiagramLayoutOptions = {},
): Promise<unknown[]> {
  const patched = applyPatchOps(elements, ops)
  const direction = options.direction ?? sceneDirection(elements)
  if (options.layout === 'keep') return finalizePatchLayout(patched, null, direction)
  const live = patched.elements
  const hasAuto = live.some((el) => isLayoutNode(el) && isAutoPlaced(el))
  // Cena só com pinados (legada sem customData, ou tudo arrastado): o frame do
  // ELK não tem relação com o desenho, então os nós novos ficam na posição
  // livre de colisão que o applyPatchOps escolheu.
  const priorAuto = new Set(
    (elements as ExElement[])
      .filter((el) => isLayoutNode(el) && isAutoPlaced(el))
      .map((el) => el.id),
  )
  const hasPinned = live.some((el) => isLayoutNode(el) && !isAutoPlaced(el))
  const elkFrameValid = !hasPinned || live.some((el) => priorAuto.has(el.id) && isLayoutNode(el))
  const layout =
    hasAuto && elkFrameValid ? await runElkLayout(elementsLayoutGraph(live, direction)) : null
  return finalizePatchLayout(patched, layout, direction)
}
