// Transparent layer over an artboard iframe in edit mode. Pointer events
// never cross the iframe boundary, so hover/select/dblclick are resolved
// here through the bridge's hitTest. Wave 3 adds move/resize/draw on top of
// the same pointerdown/move/up skeleton (see the `gesture` ref).

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { getNodeIndex, useDesignStore } from '@/store/designStore'
import type { HitMessage } from '@shared/design/protocol'
import type { ArtboardBridge } from './runtime-bridge'
import type { Point } from './geometry'

interface Props {
  artboardId: string
  bridge: ArtboardBridge
}

const CLICK_THRESHOLD_PX = 3

// Extension point: wave 3 turns 'press' into 'move' | 'resize' | 'draw'
// once the pointer travels past CLICK_THRESHOLD_PX.
interface Gesture {
  kind: 'press'
  pointerId: number
  start: Point
  moved: boolean
}

// Which node a plain click lands on: the direct child of the current scope
// (or of the root when there is no scope). Cmd/Ctrl click takes the deepest.
function resolveClickTarget(path: string[], scopeId: string | null, deep: boolean): string | null {
  if (path.length === 0) return null
  if (deep) return path[path.length - 1]
  const scopeIndex = scopeId ? path.indexOf(scopeId) : 0
  const base = scopeIndex === -1 ? 0 : scopeIndex
  return path[base + 1] ?? null
}

export function InteractionLayer({ artboardId, bridge }: Props) {
  const gestureRef = useRef<Gesture | null>(null)
  const hoverFrame = useRef<number | null>(null)
  const hoverSeq = useRef(0)
  const lastHoverPoint = useRef<Point | null>(null)

  const editingHere = useDesignStore((s) => s.textEditing?.artboardId === artboardId)
  const tool = useDesignStore((s) => s.tool)
  const setHover = useDesignStore((s) => s.setHover)
  const select = useDesignStore((s) => s.select)
  const startTextEdit = useDesignStore((s) => s.startTextEdit)

  useEffect(
    () => () => {
      if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current)
    },
    [],
  )

  const localPoint = (e: ReactPointerEvent | React.MouseEvent): Point => {
    const bounds = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const zoom = useDesignStore.getState().viewport.zoom
    return {
      x: (e.clientX - bounds.left) / zoom,
      y: (e.clientY - bounds.top) / zoom,
    }
  }

  const hit = (p: Point): Promise<HitMessage> => bridge.hitTest(p.x, p.y)

  // One hitTest per frame at most; stale replies are dropped by sequence.
  const scheduleHover = (p: Point): void => {
    lastHoverPoint.current = p
    if (hoverFrame.current !== null) return
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = null
      const point = lastHoverPoint.current
      if (!point) return
      const seq = ++hoverSeq.current
      void hit(point)
        .then((msg) => {
          if (seq !== hoverSeq.current) return
          setHover(msg.id && msg.rect ? { artboardId, nodeId: msg.id, rect: msg.rect } : null)
        })
        .catch(() => undefined)
    })
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gestureRef.current
    if (g && g.pointerId === e.pointerId) {
      const p = localPoint(e)
      const zoom = useDesignStore.getState().viewport.zoom
      if (Math.hypot(p.x - g.start.x, p.y - g.start.y) * zoom > CLICK_THRESHOLD_PX) g.moved = true
      return
    }
    if (tool === 'move') scheduleHover(localPoint(e))
  }

  const onPointerLeave = (): void => {
    hoverSeq.current++
    setHover(null)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // Middle button and the hand tool belong to the stage (pan).
    if (e.button !== 0 || tool === 'hand') return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    gestureRef.current = {
      kind: 'press',
      pointerId: e.pointerId,
      start: localPoint(e),
      moved: false,
    }
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gestureRef.current
    if (!g || g.pointerId !== e.pointerId) return
    gestureRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (g.moved || tool !== 'move') return
    const deep = e.metaKey || e.ctrlKey
    const additive = e.shiftKey
    void hit(g.start)
      .then((msg) => {
        const { scopeId, selection } = useDesignStore.getState()
        const target = resolveClickTarget(msg.path, scopeId, deep)
        if (!target) {
          if (!additive) select(artboardId, [])
          return
        }
        if (additive && selection.artboardId === artboardId) {
          const ids = selection.nodeIds.includes(target)
            ? selection.nodeIds.filter((id) => id !== target)
            : [...selection.nodeIds, target]
          select(artboardId, ids)
          return
        }
        select(artboardId, [target])
      })
      .catch(() => undefined)
  }

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (tool !== 'move') return
    e.stopPropagation()
    void hit(localPoint(e))
      .then((msg) => {
        if (!msg.id) return
        const node = getNodeIndex(artboardId)?.get(msg.id)?.node
        if (node?.kind !== 'text' || node.locked) return
        setHover(null)
        startTextEdit(artboardId, msg.id)
      })
      .catch(() => undefined)
  }

  // While editing text the iframe needs the real pointer (caret, selection).
  const passthrough = editingHere || tool === 'hand'

  return (
    <div
      className="absolute inset-0"
      style={{ pointerEvents: passthrough ? 'none' : 'auto' }}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    />
  )
}
