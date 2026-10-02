import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  defaultLiftSize,
  forgetLiftSize,
  liftSizeOf,
  readLiftSizes,
  rememberLiftSize,
  resizeLift,
  type LiftEdge,
  type LiftSize,
} from '@/features/sessions/lift-size-store'

// Redimensionar a modal do terminal (lift do mapa). Regra de ouro do terminal:
// durante o arrasto só a MOLDURA (ghost) anda; a modal — e com ela o fit do xterm
// e o resize da PTY — muda UMA vez, ao soltar.

function windowSize(): LiftSize {
  return { w: window.innerWidth, h: window.innerHeight }
}

export function useLiftFrame(sessionId: string | null) {
  const [view, setView] = useState(windowSize)
  useEffect(() => {
    const on = () => setView(windowSize())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  // rev: o localStorage não avisa; cada gravação daqui pede uma releitura.
  const [rev, setRev] = useState(0)
  const size = useMemo(
    () => (sessionId ? liftSizeOf(sessionId, view) : defaultLiftSize(view)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, view, rev],
  )
  const custom = useMemo(
    () => (sessionId ? !!readLiftSizes()[sessionId] : false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, rev],
  )
  const [ghost, setGhost] = useState<LiftSize | null>(null)

  const startResize = (edge: LiftEdge) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const sx = e.clientX
    const sy = e.clientY
    const next = (ev: PointerEvent) =>
      resizeLift(size, edge, ev.clientX - sx, ev.clientY - sy, view)
    const move = (ev: PointerEvent) => setGhost(next(ev))
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setGhost(null)
      // Clique sem arrasto (inclusive cada metade do duplo clique) não grava.
      if (ev.type === 'pointerup' && sessionId && (ev.clientX !== sx || ev.clientY !== sy)) {
        rememberLiftSize(sessionId, next(ev))
        setRev((r) => r + 1)
      }
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const reset = () => {
    if (!sessionId) return
    forgetLiftSize(sessionId)
    setRev((r) => r + 1)
  }

  return { size, ghost, custom, startResize, reset }
}

const EDGE_CLASS: Record<LiftEdge, string> = {
  n: 'top-0 inset-x-3 h-1.5 cursor-ns-resize',
  s: 'bottom-0 inset-x-3 h-1.5 cursor-ns-resize',
  e: 'right-0 inset-y-3 w-1.5 cursor-ew-resize',
  w: 'left-0 inset-y-3 w-1.5 cursor-ew-resize',
  ne: 'right-0 top-0 h-3 w-3 cursor-nesw-resize',
  sw: 'left-0 bottom-0 h-3 w-3 cursor-nesw-resize',
  nw: 'left-0 top-0 h-3 w-3 cursor-nwse-resize',
  se: 'right-0 bottom-0 h-3.5 w-3.5 cursor-nwse-resize',
}

// Alças nas bordas e cantos (visíveis no hover da modal). Duplo clique em
// qualquer uma volta ao tamanho padrão.
export function LiftHandles({
  onStart,
  onReset,
}: {
  onStart: (edge: LiftEdge) => (e: ReactPointerEvent<HTMLElement>) => void
  onReset: () => void
}) {
  return (
    <>
      {(Object.keys(EDGE_CLASS) as LiftEdge[]).map((edge) => (
        <div
          key={edge}
          data-testid={`peek-resize-${edge}`}
          aria-hidden="true"
          title="Arraste para redimensionar · duplo clique: tamanho padrão"
          onPointerDown={onStart(edge)}
          onDoubleClick={onReset}
          className={`absolute z-20 rounded-sm opacity-0 transition hover:bg-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] group-hover/lift:opacity-100 ${EDGE_CLASS[edge]}`}
        />
      ))}
    </>
  )
}

// Moldura do arrasto, centrada como a modal (o tamanho real só muda ao soltar).
export function LiftGhost({ size }: { size: LiftSize }) {
  return (
    <div
      data-testid="peek-resize-ghost"
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-1/2 z-10 rounded-lg border-2 border-dashed border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_6%,transparent)]"
      style={{ width: size.w, height: size.h, transform: 'translate(-50%, -50%)' }}
    >
      <span className="absolute bottom-2 right-3 rounded bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text-dim)]">
        {size.w} × {size.h}
      </span>
    </div>
  )
}
