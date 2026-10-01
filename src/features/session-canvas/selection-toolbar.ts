// Onde a toolbar de seleção do mapa fica (acima ou abaixo do nó) sem cobrir o
// cabeçalho de um grupo, lane de projeto/repo ou card de feature. Puro: o
// SelectionToolbar passa as caixas absolutas (unidades do fluxo) do nodeLookup.

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export type ToolbarSide = 'top' | 'bottom'

// Nós com faixa de cabeçalho no topo (lanes, grupos do usuário, card da feature).
const HEADER_NODE_TYPES = new Set(['lane', 'userGroup', 'feature'])

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Faixa do cabeçalho de cada nó-contêiner; `headerH` no data vence o padrão. */
export function headerBoxes(
  nodes: Iterable<{ type?: string; box: Box; headerH?: number }>,
  defaultHeaderH: number,
): Box[] {
  const out: Box[] = []
  for (const n of nodes) {
    if (!n.type || !HEADER_NODE_TYPES.has(n.type)) continue
    out.push({ x: n.box.x, y: n.box.y, w: n.box.w, h: n.headerH ?? defaultHeaderH })
  }
  return out
}

/**
 * Acima do nó, a não ser que ali a toolbar cubra um cabeçalho; aí vai para
 * baixo. Se os dois lados colidem, fica em cima (o padrão).
 * `toolbarW` é a largura da toolbar em unidades do fluxo (centrada no nó).
 */
export function toolbarSideAvoiding(
  node: Box,
  headers: Box[],
  clearance: number,
  toolbarW: number = node.w,
): ToolbarSide {
  const w = Math.max(node.w, toolbarW)
  const x = node.x + node.w / 2 - w / 2
  const above: Box = { x, y: node.y - clearance, w, h: clearance }
  const below: Box = { x, y: node.y + node.h, w, h: clearance }
  // O cabeçalho do PRÓPRIO nó-contêiner não conta: a toolbar fica fora dele.
  const others = headers.filter((h) => !(h.x === node.x && h.y === node.y && h.w === node.w))
  const hitsAbove = others.some((h) => intersects(above, h))
  if (!hitsAbove) return 'top'
  return others.some((h) => intersects(below, h)) ? 'top' : 'bottom'
}

// A toolbar (NodeToolbar) tem tamanho FIXO na tela: a zoom z ela ocupa
// tamanho/z unidades do fluxo. Converter só a largura deixava a altura em 44
// unidades, e a 0,5 a toolbar real (88 unidades) cobria o cabeçalho de cima.
export function toolbarSideAtZoom(
  node: Box,
  headers: Box[],
  zoom: number,
  screen: { clearance: number; minW: number },
): ToolbarSide {
  const z = zoom || 1
  return toolbarSideAvoiding(node, headers, screen.clearance / z, screen.minW / z)
}
