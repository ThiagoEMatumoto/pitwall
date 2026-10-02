// A "bolinha de informação" que corre no fio quando uma sessão manda algo para
// outra. O movimento é imperativo (rAF mexendo em cx/cy por ref): nenhum frame da
// animação passa pelo React, e só o fio do par afetado re-renderiza (edge-pulse-store).
import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useInternalNode, ViewportPortal, type InternalNode } from '@xyflow/react'
import { sessionGraphApi } from '@/lib/ipc'
import { borderAnchor, type Rect } from './edge-anchor'
import {
  PULSE_COLOR,
  PULSE_PING_MS,
  PULSE_TRAVEL_MS,
  arcPath,
  edgePulseStore,
  pulseDirection,
  pulseFraction,
  useOrphanPulses,
  type ActivePulse,
} from './edge-pulse-store'
import { CARD_Z, EDGE_Z, sessionNodeId, type MapNode } from './graph-to-flow'

// Rastro: cópias menores da cabeça, cada uma um pouco atrás no tempo.
const TRAIL_STEPS = [40, 80, 120, 160]
const TRAIL_R = [5, 4, 3, 2.2]
const TRAIL_OPACITY = [0.45, 0.3, 0.18, 0.1]

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)'

function subscribeReduced(fn: () => void): () => void {
  const mq = window.matchMedia?.(REDUCED_QUERY)
  mq?.addEventListener('change', fn)
  return () => mq?.removeEventListener('change', fn)
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia?.(REDUCED_QUERY).matches ?? false,
    () => false,
  )
}

export function rectOfNode(n: InternalNode<MapNode> | undefined): Rect | null {
  if (!n) return null
  const w = n.measured.width ?? n.width
  const h = n.measured.height ?? n.height
  if (!w || !h) return null
  const p = n.internals.positionAbsolute
  return { x: p.x, y: p.y, w, h }
}

function place(el: SVGCircleElement | null, path: SVGPathElement, total: number, f: number) {
  if (!el) return
  const pt = path.getPointAtLength(total * f)
  el.setAttribute('cx', String(pt.x))
  el.setAttribute('cy', String(pt.y))
}

interface DotProps {
  d: string
  pulse: ActivePulse
  direction: 'forward' | 'reverse'
  onArrive(): void
}

function PulseDot({ d, pulse, direction, onArrive }: DotProps) {
  const pathRef = useRef<SVGPathElement>(null)
  const groupRef = useRef<SVGGElement>(null)
  const headRef = useRef<SVGCircleElement>(null)
  const haloRef = useRef<SVGCircleElement>(null)
  const trailRefs = useRef<(SVGCircleElement | null)[]>([])
  const arriveRef = useRef(onArrive)
  arriveRef.current = onArrive

  useEffect(() => {
    let raf = 0
    let done = false
    const tick = () => {
      const path = pathRef.current
      const g = groupRef.current
      if (!path || !g) return
      const elapsed = performance.now() - pulse.startAt
      // jsdom não mede path; sem medida não há o que animar.
      const total = typeof path.getTotalLength === 'function' ? path.getTotalLength() : 0
      if (elapsed < 0 || total === 0) {
        g.style.opacity = '0'
        if (total > 0) raf = requestAnimationFrame(tick)
        return
      }
      if (elapsed >= PULSE_TRAVEL_MS) {
        g.style.opacity = '0'
        if (!done) {
          done = true
          arriveRef.current()
        }
        return
      }
      const f = pulseFraction(elapsed, direction)
      place(headRef.current, path, total, f)
      place(haloRef.current, path, total, f)
      TRAIL_STEPS.forEach((lag, i) => {
        place(
          trailRefs.current[i],
          path,
          total,
          pulseFraction(Math.max(0, elapsed - lag), direction),
        )
      })
      // Acende ao sair e apaga ao pousar, em vez de surgir/sumir seco.
      const t = elapsed / PULSE_TRAVEL_MS
      g.style.opacity = String(Math.min(1, t * 8, (1 - t) * 10 + 0.15))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [d, pulse.startAt, direction])

  const color = PULSE_COLOR[pulse.kind]
  return (
    <g
      ref={groupRef}
      data-edge-pulse=""
      data-pulse-id={pulse.id}
      data-from={pulse.from}
      data-to={pulse.to}
      data-kind={pulse.kind}
      data-direction={direction}
      style={{ opacity: 0, pointerEvents: 'none' }}
    >
      <path ref={pathRef} d={d} fill="none" stroke="none" />
      {TRAIL_STEPS.map((_, i) => (
        <circle
          key={i}
          ref={(el) => {
            trailRefs.current[i] = el
          }}
          r={TRAIL_R[i]}
          fill={color}
          opacity={TRAIL_OPACITY[i]}
        />
      ))}
      <circle ref={haloRef} r={16} fill={color} opacity={0.2} className="edge-pulse-halo" />
      <circle
        ref={headRef}
        r={6.5}
        fill={color}
        stroke="var(--color-surface)"
        strokeWidth={1.75}
        className="edge-pulse-head"
        style={{ filter: `drop-shadow(0 0 6px ${color}) drop-shadow(0 0 14px ${color})` }}
        data-edge-pulse-head=""
      />
    </g>
  )
}

// Anel que se expande e some em volta do cartão que recebeu.
function PulsePing({ rect, pulse }: { rect: Rect; pulse: ActivePulse }) {
  const pad = 3
  return (
    <rect
      data-edge-ping=""
      data-session={pulse.to}
      data-kind={pulse.kind}
      x={rect.x - pad}
      y={rect.y - pad}
      width={rect.w + pad * 2}
      height={rect.h + pad * 2}
      rx={14}
      fill="none"
      stroke={PULSE_COLOR[pulse.kind]}
      strokeWidth={2}
      className="edge-pulse-ping"
      style={{ animationDuration: `${PULSE_PING_MS}ms`, pointerEvents: 'none' }}
    />
  )
}

// Sem movimento: o fio só pisca na cor do tipo, no momento em que o pulso sairia.
function PulseFlash({ d, pulse }: { d: string; pulse: ActivePulse }) {
  const delay = Math.max(0, pulse.startAt - performance.now())
  return (
    <path
      data-edge-pulse-flash=""
      data-from={pulse.from}
      data-to={pulse.to}
      data-kind={pulse.kind}
      d={d}
      fill="none"
      stroke={PULSE_COLOR[pulse.kind]}
      strokeWidth={3}
      strokeLinecap="round"
      className="edge-pulse-flash"
      style={{ animationDelay: `${delay}ms`, pointerEvents: 'none' }}
    />
  )
}

export interface PulseTrainProps {
  // Path do fio, desenhado de `sourceSessionId` para a outra ponta.
  d: string
  sourceSessionId: string
  pulses: readonly ActivePulse[]
  rects: Record<string, Rect | null>
  // Fio fora do foco (focus.dimOthers): o trem passa apagado e sem ping no
  // cartão destino, para não puxar o olho para longe do que está em foco.
  dimmed?: boolean
  // 'wire' = só o fio aceso (fica na camada dos fios, abaixo dos cartões);
  // 'dots' = só as bolinhas e o ping (na camada de cima, ver PULSE_TOP_LAYER_STYLE).
  parts?: 'all' | 'wire' | 'dots'
}

// Opacidade do trem num fio esmaecido: visível de perto, sem competir com o foco.
export const DIMMED_PULSE_OPACITY = 0.25

function PulseItem({
  d,
  pulse,
  sourceSessionId,
  rect,
  reduced,
  dimmed,
}: {
  d: string
  pulse: ActivePulse
  sourceSessionId: string
  rect: Rect | null
  reduced: boolean
  dimmed: boolean
}) {
  const [arrived, setArrived] = useState(false)
  if (reduced) return <PulseFlash d={d} pulse={pulse} />
  return (
    <>
      {!arrived && (
        <PulseDot
          d={d}
          pulse={pulse}
          direction={pulseDirection(sourceSessionId, pulse)}
          onArrive={() => setArrived(true)}
        />
      )}
      {arrived && rect && !dimmed && <PulsePing rect={rect} pulse={pulse} />}
    </>
  )
}

export const PulseTrain = memo(function PulseTrain({
  d,
  sourceSessionId,
  pulses,
  rects,
  dimmed = false,
  parts = 'all',
}: PulseTrainProps) {
  const reduced = useReducedMotion()
  if (pulses.length === 0) return null
  const wire = parts !== 'dots'
  // Sem movimento o pulso é só um flash do fio: fica na camada do fio.
  const dots = reduced ? wire : parts !== 'wire'
  if (!wire && !dots) return null
  return (
    <g
      className="edge-pulse-train"
      data-dimmed={dimmed ? '' : undefined}
      style={dimmed ? { opacity: DIMMED_PULSE_OPACITY } : undefined}
    >
      {/* O fio acende de leve enquanto o trem passa. */}
      {!reduced && wire && (
        <path
          d={d}
          fill="none"
          stroke={PULSE_COLOR[pulses[0].kind]}
          strokeWidth={2.5}
          className="edge-pulse-wire"
          style={{ pointerEvents: 'none' }}
        />
      )}
      {dots &&
        pulses.map((p) => (
          <PulseItem
            key={p.id}
            d={d}
            pulse={p}
            sourceSessionId={sourceSessionId}
            rect={rects[p.to] ?? null}
            reduced={reduced}
            dimmed={dimmed}
          />
        ))}
    </g>
  )
})

// ---- par sem fio: arco temporário só durante o pulso ----

function OrphanArc({ pulse }: { pulse: ActivePulse }) {
  const from = rectOfNode(useInternalNode<MapNode>(sessionNodeId(pulse.from)))
  const to = rectOfNode(useInternalNode<MapNode>(sessionNodeId(pulse.to)))
  // Cartão fora do mapa: nada a desenhar (e a câmera nunca se mexe por um pulso).
  if (!from || !to) return null
  const a = borderAnchor(from, to)
  const b = borderAnchor(to, from)
  const d = arcPath(a, b)
  return (
    <g data-edge-pulse-arc="" data-from={pulse.from} data-to={pulse.to}>
      <path
        d={d}
        fill="none"
        stroke={PULSE_COLOR[pulse.kind]}
        strokeWidth={1.25}
        strokeDasharray="2 5"
        strokeLinecap="round"
        className="edge-pulse-arc"
        style={{ animationDuration: `${PULSE_TRAVEL_MS + PULSE_PING_MS}ms` }}
      />
      <PulseTrain d={d} sourceSessionId={pulse.from} pulses={[pulse]} rects={{ [pulse.to]: to }} />
    </g>
  )
}

function useLastLabel(): string {
  return useSyncExternalStore(
    (fn) => edgePulseStore.subscribeAny(fn),
    () => edgePulseStore.lastLabel(),
  )
}

// O ViewportPortal vem depois dos nós no DOM e não cria stacking context: sem z o
// arco subiria por cima dos cartões (e do tail ao vivo). Com o z dos fios ele fica
// na mesma camada deles, abaixo de todo cartão (zIndexMode 'manual').
// Camada das bolinhas dos fios: ACIMA dos cartões, só enquanto o trem passa. O
// fio corre por baixo de cartões no caminho (mãe→filha distante atravessa a
// irmã); na camada dos fios a bolinha sumia atrás deles e só o ping aparecia.
export const PULSE_TOP_LAYER_STYLE = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: 1,
  height: 1,
  overflow: 'visible',
  pointerEvents: 'none',
  zIndex: CARD_Z + 1,
} as const

export const ORPHAN_LAYER_STYLE = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: 1,
  height: 1,
  overflow: 'visible',
  pointerEvents: 'none',
  zIndex: EDGE_Z,
} as const

// Montado uma vez dentro do <ReactFlow>: liga o IPC ao store, desenha os arcos dos
// pares sem fio e anuncia (aria-live, discreto) o que acabou de passar.
export function PulseLayer() {
  useEffect(() => sessionGraphApi.onLinkPulse?.((p) => edgePulseStore.add(p)), [])
  const orphans = useOrphanPulses()
  const label = useLastLabel()
  return (
    <>
      {orphans.length > 0 && (
        <ViewportPortal>
          <svg className="edge-pulse-layer" style={ORPHAN_LAYER_STYLE}>
            {orphans.map((p) => (
              <OrphanArc key={p.id} pulse={p} />
            ))}
          </svg>
        </ViewportPortal>
      )}
      <div className="sr-only" aria-live="polite" data-testid="edge-pulse-announce">
        {label}
      </div>
    </>
  )
}
