// Transparent layer over an artboard iframe in edit mode. Pointer events
// never cross the iframe boundary, so hover, clicks and every drag gesture
// are resolved here through the bridge's hitTest. The gesture itself lives in
// GestureRunner (interaction-state.ts); this component only translates DOM
// events into artboard-local points and owns hover + cursor.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { getNodeIndex, useDesignStore } from '@/store/designStore'
import type { HitMessage } from '@shared/design/protocol'
import type { ArtboardBridge } from './runtime-bridge'
import type { Point } from './geometry'
import { HANDLE_CURSOR, handleAt, type ResizeHandle } from './drag-plan'
import { GestureRunner } from './gesture-runner'
import { resolveDiveTarget } from './interaction-state'

interface Props {
  artboardId: string
  bridge: ArtboardBridge
}

const HANDLE_HIT_RADIUS_PX = 6

export function InteractionLayer({ artboardId, bridge }: Props) {
  const runnerRef = useRef<GestureRunner | null>(null)
  const hoverFrame = useRef<number | null>(null)
  const hoverSeq = useRef(0)
  const lastHoverPoint = useRef<Point | null>(null)
  const [cursor, setCursor] = useState<string | undefined>(undefined)

  const editingHere = useDesignStore((s) => s.textEditing?.artboardId === artboardId)
  const tool = useDesignStore((s) => s.tool)
  const setHover = useDesignStore((s) => s.setHover)
  const startTextEdit = useDesignStore((s) => s.startTextEdit)

  if (!runnerRef.current) runnerRef.current = new GestureRunner(artboardId, bridge)
  runnerRef.current.bridge = bridge
  const runner = runnerRef.current

  useEffect(
    () => () => {
      if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current)
      runnerRef.current?.dispose()
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

  // Resize handle under the pointer, if this artboard owns the selection.
  const handleUnder = (p: Point): { nodeId: string; handle: ResizeHandle } | null => {
    const { selection, viewport, textEditing } = useDesignStore.getState()
    if (selection.artboardId !== artboardId || textEditing) return null
    const radius = HANDLE_HIT_RADIUS_PX / viewport.zoom
    for (const nodeId of selection.nodeIds) {
      const rect = bridge.getCachedRect(nodeId)
      if (!rect) continue
      const handle = handleAt(p, rect, radius)
      if (handle) return { nodeId, handle }
    }
    return null
  }

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
    const p = localPoint(e)
    if (runner.active(e.pointerId)) {
      runner.move(p, { shift: e.shiftKey, alt: e.altKey })
      return
    }
    if (tool !== 'move') return
    const handle = handleUnder(p)
    setCursor(handle ? HANDLE_CURSOR[handle.handle] : undefined)
    if (handle) {
      hoverSeq.current++
      setHover(null)
      return
    }
    scheduleHover(p)
  }

  const onPointerLeave = (): void => {
    hoverSeq.current++
    setHover(null)
    setCursor(undefined)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // Middle button and the hand tool belong to the stage (pan).
    if (e.button !== 0 || tool === 'hand') return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    hoverSeq.current++
    const start = localPoint(e)
    runner.press({
      kind: 'press',
      pointerId: e.pointerId,
      start,
      last: start,
      moved: false,
      tool,
      handle: tool === 'move' ? handleUnder(start) : null,
      hit: null,
      shift: e.shiftKey,
      deep: e.metaKey || e.ctrlKey,
      alt: e.altKey,
    })
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!runner.active(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    runner.up(localPoint(e), { shift: e.shiftKey, alt: e.altKey })
  }

  // Text: edit it. Anything else: dive one level into the container under
  // the pointer, so the deep node is reachable without knowing Ctrl+click.
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (tool !== 'move') return
    e.stopPropagation()
    void hit(localPoint(e))
      .then((msg) => {
        if (!msg.id) return
        const node = getNodeIndex(artboardId)?.get(msg.id)?.node
        if (node?.kind === 'text' && !node.locked) {
          setHover(null)
          startTextEdit(artboardId, msg.id)
          return
        }
        const { selection, scopeId, select, setScope } = useDesignStore.getState()
        const selected = selection.artboardId === artboardId ? selection.nodeIds : []
        const dive = resolveDiveTarget(msg.path, selected, scopeId)
        if (!dive) return
        // The root is the artboard itself: no scope, plain top-level selection.
        setScope(dive.scopeId === msg.path[0] ? null : dive.scopeId)
        select(artboardId, [dive.nodeId])
      })
      .catch(() => undefined)
  }

  // While editing text the iframe needs the real pointer (caret, selection).
  const passthrough = editingHere || tool === 'hand'

  return (
    <div
      className="absolute inset-0"
      style={{ pointerEvents: passthrough ? 'none' : 'auto', cursor }}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    />
  )
}
