// PURO: o botão "Organizar". Recalcula o layout como se nada tivesse posição
// salva (lanes lado a lado, cartões em coluna, grupos abaixo, notas na calha) e
// devolve o que gravar em canvas_positions — o mesmo layout inicial do mapa.
import type { CanvasPositionInput } from '../../../shared/types/canvas'
import { graphToFlow, positionKey, type MapInput } from './graph-to-flow'

export function tidyPositions(input: MapInput): CanvasPositionInput[] {
  const { nodes } = graphToFlow({ ...input, positions: [] })
  return nodes.flatMap((n) => {
    const key = positionKey(n.id)
    if (!key) return []
    const size = key.kind === 'note' ? { w: n.width ?? null, h: n.height ?? null } : {}
    return [{ ...key, x: n.position.x, y: n.position.y, ...size }]
  })
}
