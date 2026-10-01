import { memo, useState, type CSSProperties } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
  type EdgeProps,
  type InternalNode,
} from '@xyflow/react'
import { sessionGraphApi } from '@/lib/ipc'
import type { HandoffEvent } from '../../../shared/types/session-graph'
import type { MapEdge, MapEdgeData, MapEdgeKind, MapNode } from './graph-to-flow'
import { borderAnchor, type Anchor, type Rect } from './edge-anchor'
import { useMapFocus } from './map-focus'

// Cada tipo de fio se lê sem legenda: mãe→filha é a corda sólida com seta (corre
// quando vivo, pulsa vermelho quando a filha pergunta), bastão é violeta com ⟲,
// dependência entre repos é pontilhada e discreta, feature (mesma frente) só
// aparece no foco. Animações desligam em prefers-reduced-motion (session-map.css).
const BASE: Record<MapEdgeKind, CSSProperties> = {
  handoff: { stroke: 'var(--color-text-dim)', strokeWidth: 1.5 },
  baton: { stroke: 'var(--color-violet)', strokeWidth: 1.5 },
  repoDep: {
    stroke: 'var(--color-border)',
    strokeWidth: 1.25,
    strokeDasharray: '1 4',
    strokeLinecap: 'round',
    opacity: 0.9,
  },
  feature: {
    stroke: 'var(--color-info)',
    strokeWidth: 1.5,
    strokeDasharray: '1 5',
    strokeLinecap: 'round',
  },
  note: { stroke: 'var(--color-text-dim)', strokeWidth: 1, strokeDasharray: '2 4', opacity: 0.8 },
}

function edgeStyle(data: MapEdgeData): CSSProperties {
  const base = BASE[data.kind]
  if (data.kind !== 'handoff') return base
  if (data.alert) return { ...base, stroke: 'var(--color-danger)', strokeWidth: 2 }
  // Vivo: tracejado que "corre" (session-edge-live) pra mostrar que está trabalhando.
  if (data.live) return { ...base, stroke: 'var(--color-accent)', strokeDasharray: '6 5' }
  return { ...base, opacity: 0.7 }
}

function edgeClass(data: MapEdgeData): string {
  if (data.kind !== 'handoff') return ''
  if (data.alert) return 'session-edge-alert'
  return data.live ? 'session-edge-live' : ''
}

function rectOf(n: InternalNode<MapNode> | undefined): Rect | null {
  if (!n) return null
  const w = n.measured.width ?? n.width
  const h = n.measured.height ?? n.height
  if (!w || !h) return null
  const p = n.internals.positionAbsolute
  return { x: p.x, y: p.y, w, h }
}

// A ponta encaixa no centro do handle daquela borda (o ponto que o cartão
// desenha), não num ponto calculado ao lado dele. Sem handle ali (lane de repo
// só tem os laterais), fica o meio da borda.
function snapToHandle(n: InternalNode<MapNode> | undefined, a: Anchor): Anchor {
  const bounds = n?.internals.handleBounds
  const h = [...(bounds?.target ?? []), ...(bounds?.source ?? [])].find(
    (b) => b.position === a.position,
  )
  if (!n || !h) return a
  const p = n.internals.positionAbsolute
  return { ...a, x: p.x + h.x + h.width / 2, y: p.y + h.y + h.height / 2 }
}

// Com os dois nós medidos o fio encosta na borda voltada pro outro; antes disso
// (1º frame) cai nos handles padrão que o xyflow passa.
function useFloatingPath(props: EdgeProps<MapEdge>) {
  const sourceNode = useInternalNode<MapNode>(props.source)
  const targetNode = useInternalNode<MapNode>(props.target)
  const source = rectOf(sourceNode)
  const target = rectOf(targetNode)
  if (!source || !target) return getBezierPath(props)
  const a = snapToHandle(sourceNode, borderAnchor(source, target))
  const b = snapToHandle(targetNode, borderAnchor(target, source))
  return getBezierPath({
    sourceX: a.x,
    sourceY: a.y,
    sourcePosition: a.position,
    targetX: b.x,
    targetY: b.y,
    targetPosition: b.position,
  })
}

function timeline(events: HandoffEvent[]): string {
  return events
    .map((e) => {
      const at = new Date(e.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      return `${at} · ${e.event}${e.detail ? ` — ${e.detail}` : ''}`
    })
    .join('\n')
}

function SessionEdgeImpl(props: EdgeProps<MapEdge>) {
  const data = props.data as MapEdgeData
  const [tooltip, setTooltip] = useState<string | null>(null)
  const [path, labelX, labelY] = useFloatingPath(props)
  const focus = useMapFocus()
  const lit = focus.edges.has(props.id)
  const dimmed = focus.dimOthers && !lit
  // Rótulos ficam acima dos cartões (z do EdgeLabelRenderer em session-map.css).
  // Mapa cheio (busy, > EDGE_BUSY_THRESHOLD fios): só no fio em foco
  // (hover/seleção), senão viram sopa; a pergunta da filha aparece sempre.
  const showLabel = !!data.label && !dimmed && (!data.busy || lit || data.alert)
  const base = edgeStyle(data)
  const style: CSSProperties = lit
    ? { ...base, opacity: 1, strokeWidth: Number(base.strokeWidth ?? 1) + 0.75 }
    : dimmed
      ? { ...base, opacity: 0.12 }
      : base

  // Linha do tempo do handoff só no hover: um IPC por fio visível no mount
  // seria desperdício — quase ninguém para o mouse na maioria deles.
  function loadTimeline() {
    if (tooltip !== null || !data.handoffId) return
    setTooltip('carregando…')
    sessionGraphApi
      .handoffEvents({ handoffId: data.handoffId })
      .then((events) => setTooltip(timeline(events) || 'sem eventos'))
      .catch(() => setTooltip('linha do tempo indisponível'))
  }

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={style}
        className={edgeClass(data)}
        markerEnd={data.kind === 'baton' || data.kind === 'handoff' ? props.markerEnd : undefined}
        interactionWidth={16}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            onMouseEnter={loadTimeline}
            title={tooltip ?? undefined}
            data-testid={`edge-label-${data.kind}`}
            data-lit={lit ? 'true' : undefined}
            className="nodrag nopan pointer-events-auto absolute max-w-[180px] truncate rounded-full border px-1.5 py-0.5 text-[10px]"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              borderColor: data.alert ? 'var(--color-danger)' : 'var(--color-border)',
              background: 'var(--color-surface)',
              color: data.alert ? 'var(--color-danger)' : 'var(--color-text-dim)',
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const SessionEdge = memo(SessionEdgeImpl)
