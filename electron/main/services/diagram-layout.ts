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
  'elk.spacing.edgeEdge': '20',
  'elk.spacing.edgeLabel': '8',
  'elk.spacing.componentComponent': '100',
  'elk.edgeLabels.placement': 'CENTER',
}

const toPoint = (p: { x: number; y: number }): Point => [p.x, p.y]

export async function runElkLayout(graph: LayoutGraph): Promise<LayoutResult> {
  const root: ElkNode = {
    id: '__root__',
    layoutOptions: {
      ...LAYOUT_OPTIONS,
      'elk.direction': graph.direction === 'TB' ? 'DOWN' : 'RIGHT',
    },
    children: graph.nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: graph.edges.map((e): ElkExtendedEdge => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
      ...(e.label ? { labels: [{ id: `${e.id}__elk_label`, ...e.label }] } : {}),
    })),
  }
  const out = await elk.layout(root)
  const positions = new Map<string, { x: number; y: number }>()
  for (const child of out.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 })
  }
  const routes = new Map<string, Point[]>()
  for (const edge of out.edges ?? []) {
    const section = edge.sections?.[0]
    if (!section) continue
    routes.set(edge.id, [
      toPoint(section.startPoint),
      ...(section.bendPoints ?? []).map(toPoint),
      toPoint(section.endPoint),
    ])
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
