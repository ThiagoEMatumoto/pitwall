import { createContext, useContext } from 'react'

// "Modo foco" do mapa: o cartão selecionado esmaece o resto e acende os próprios
// fios; o hover só acende (revela fios agregados e rótulos) sem esmaecer nada.
// Contexto próprio, separado das ações: muda a cada hover e não pode invalidar
// quem só dispara comandos.
export interface MapFocus {
  // Cartão selecionado (s:<id>): com ele, quem não é ligado a ele esmaece.
  dimOthers: boolean
  // Nós em destaque: o cartão em foco + as pontas dos fios dele.
  nodes: ReadonlySet<string>
  // Fios em destaque: os que tocam o cartão em foco (ou a lane do repo dele).
  edges: ReadonlySet<string>
}

const EMPTY: MapFocus = { dimOthers: false, nodes: new Set(), edges: new Set() }

export const MapFocusContext = createContext<MapFocus>(EMPTY)

export function useMapFocus(): MapFocus {
  return useContext(MapFocusContext)
}

interface FocusEdge {
  id: string
  source: string
  target: string
}

// Fios que tocam o nó em foco: direto (handoff, bastão, feature, nota) ou pela
// lane do repo dele (repoDep liga lanes, não cartões).
export function focusFor(
  focusId: string | null,
  repoLaneOf: string | null,
  edges: FocusEdge[],
  dimOthers: boolean,
): MapFocus {
  if (!focusId) return EMPTY
  const nodes = new Set([focusId])
  const hit = new Set<string>()
  for (const e of edges) {
    const touches =
      e.source === focusId ||
      e.target === focusId ||
      (repoLaneOf != null && (e.source === repoLaneOf || e.target === repoLaneOf))
    if (!touches) continue
    hit.add(e.id)
    nodes.add(e.source)
    nodes.add(e.target)
  }
  return { dimOthers, nodes, edges: hit }
}
