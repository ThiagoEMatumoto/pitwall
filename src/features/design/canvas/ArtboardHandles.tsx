// The resize handles of the selected artboard, rendered by ArtboardFrame as
// a later sibling of the InteractionLayer so the corners win the hit test.
// Deltas come from client coordinates: the artboard box moves and grows
// under the pointer during the drag, so anything measured against it drifts.

import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useDesignStore } from '@/store/designStore'
import type { Rect } from '@shared/design/protocol'
import { HANDLE_CURSOR, handleCenters, type ResizeHandle, type ResizeMods } from './drag-plan'
import { SNAP_THRESHOLD_PX, computeSnap, type SnapEdge } from './snapping'
import {
  artboardHandles,
  planArtboardResize,
  resizeArtboardBox,
  siblingBounds,
  type ArtboardBox,
} from './artboard-drag'
import type { Point } from './geometry'

interface Props {
  artboardId: string
}

const HANDLE_SIZE_PX = 8

interface Drag {
  pointerId: number
  handle: ResizeHandle
  clientX: number
  clientY: number
  box: ArtboardBox
  candidates: Rect[]
  dirty: boolean
}

// Only the dragged edge snaps, like the node resize does.
function snapEdges(handle: ResizeHandle, axis: 'x' | 'y'): SnapEdge[] {
  const far = axis === 'x' ? 'e' : 's'
  const near = axis === 'x' ? 'w' : 'n'
  if (handle.includes(far)) return ['end']
  if (handle.includes(near)) return ['start']
  return []
}

export function ArtboardHandles({ artboardId }: Props) {
  const dragRef = useRef<Drag | null>(null)
  const meta = useDesignStore((s) => s.artboards[artboardId]?.meta)
  const zoom = useDesignStore((s) => s.viewport.zoom)
  const commit = useDesignStore((s) => s.commit)
  const releaseTransient = useDesignStore((s) => s.releaseTransient)

  if (!meta) return null

  const box: ArtboardBox = {
    x: meta.x,
    y: meta.y,
    width: meta.width,
    height: meta.height,
    sizing: meta.sizing,
  }

  const snappedDelta = (d: Drag, e: ReactPointerEvent, mods: ResizeMods): Point => {
    const z = useDesignStore.getState().viewport.zoom
    const dx = (e.clientX - d.clientX) / z
    const dy = (e.clientY - d.clientY) / z
    if (mods.alt) return { x: dx, y: dy }
    const next = resizeArtboardBox(d.box, d.handle, dx, dy, mods)
    const snap = computeSnap(
      { x: next.x, y: next.y, w: next.width, h: next.height },
      d.candidates,
      SNAP_THRESHOLD_PX / z,
      {
        edgesX: snapEdges(d.handle, 'x'),
        edgesY: d.box.sizing === 'flow' ? [] : snapEdges(d.handle, 'y'),
      },
    )
    return { x: dx + snap.dx, y: dy + snap.dy }
  }

  const onPointerDown =
    (handle: ResizeHandle) =>
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0) return
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      const metas = Object.values(useDesignStore.getState().artboards).map((a) => a.meta)
      dragRef.current = {
        pointerId: e.pointerId,
        handle,
        clientX: e.clientX,
        clientY: e.clientY,
        box,
        candidates: siblingBounds(metas, meta),
        dirty: false,
      }
    }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const mods = { shift: e.shiftKey, alt: e.altKey }
    const delta = snappedDelta(d, e, mods)
    const ops = planArtboardResize(d.box, d.handle, delta.x, delta.y, mods)
    if (ops.length === 0) return
    d.dirty = true
    commit(artboardId, ops, {
      transient: true,
      coalesceKey: `artboard-resize:${artboardId}`,
    })
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    const mods = { shift: e.shiftKey, alt: e.altKey }
    const delta = snappedDelta(d, e, mods)
    const ops = planArtboardResize(d.box, d.handle, delta.x, delta.y, mods)
    // Nothing landed: the transient ops painted a box the server never saw.
    if (ops.length === 0) {
      releaseTransient(artboardId)
      return
    }
    commit(artboardId, ops, { coalesceKey: `artboard:${artboardId}` })
  }

  // Pointer capture lost mid-drag: the canvas must not keep the box the
  // transient ops painted.
  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    dragRef.current = null
    releaseTransient(artboardId)
  }

  const size = HANDLE_SIZE_PX / zoom
  const allowed = artboardHandles(box)

  return (
    <>
      {handleCenters({ x: 0, y: 0, w: meta.width, h: meta.height })
        .filter(([handle]) => allowed.includes(handle))
        .map(([handle, hx, hy]) => (
          <div
            key={handle}
            className="absolute"
            style={{
              left: hx - size / 2,
              top: hy - size / 2,
              width: size,
              height: size,
              background: 'var(--color-surface)',
              boxShadow: `0 0 0 ${1.5 / zoom}px var(--color-accent)`,
              cursor: HANDLE_CURSOR[handle],
              touchAction: 'none',
            }}
            onPointerDown={onPointerDown(handle)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
          />
        ))}
    </>
  )
}
