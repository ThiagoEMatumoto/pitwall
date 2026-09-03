// Infinite canvas: a screen-sized container with a translated/scaled stage
// inside. Pan/zoom/marquee/drop live here; per-artboard pointer work lives
// in InteractionLayer (rendered by ArtboardFrame inside the stage).

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useDesignStore, setStageSize } from '@/store/designStore'
import type { DesignTool } from '@/store/designStore'
import { newNodeId } from '@shared/design/ids'
import type { Rect } from '@shared/design/protocol'
import type { DesignAssetMime, DesignNode } from '@shared/types/design'
import { ArtboardFrame, ArtboardPlaceholder } from './ArtboardFrame'
import { SelectionOverlay } from './SelectionOverlay'
import {
  artboardBounds,
  artboardScreenRect,
  rectContains,
  rectFromPoints,
  rectsIntersect,
  screenToCanvas,
  visibleArtboardIds,
  zoomAt,
  type Point,
  type Size,
} from './geometry'
import { EmptyState } from '../EmptyState'

// Tighter than geometry's hard limit above: past 800% the iframe re-raster
// gets slow. 2% is what fits a 16384px landing next to its siblings.
export const STAGE_MIN_ZOOM = 0.02
export const STAGE_MAX_ZOOM = 8
// Artboards this many stage sizes away from the viewport are not mounted
// (each iframe is a renderer process); generous so panning rarely flickers.
const LAZY_MOUNT_MARGIN = 2
const WHEEL_ZOOM_SENSITIVITY = 0.01
const GRID_STEP = 24
const MARQUEE_THRESHOLD_PX = 3

const IMAGE_MIMES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
])

export function clampStageZoom(zoom: number): number {
  return Math.min(STAGE_MAX_ZOOM, Math.max(STAGE_MIN_ZOOM, zoom))
}

type Gesture =
  | { kind: 'pan'; pointerId: number; last: Point }
  | {
      kind: 'marquee'
      pointerId: number
      origin: Point
      current: Point
      additive: boolean
    }

const CURSOR: Record<DesignTool, string> = {
  move: 'default',
  hand: 'grab',
  frame: 'crosshair',
  rect: 'crosshair',
  ellipse: 'crosshair',
  text: 'text',
  image: 'crosshair',
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function CanvasStage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [stage, setStage] = useState<Size>({ w: 0, h: 0 })

  const viewport = useDesignStore((s) => s.viewport)
  const setViewport = useDesignStore((s) => s.setViewport)
  const tool = useDesignStore((s) => s.tool)
  const setTool = useDesignStore((s) => s.setTool)
  const mode = useDesignStore((s) => s.mode)
  const docId = useDesignStore((s) => s.docId)
  const pageId = useDesignStore((s) => s.pageId)
  const artboards = useDesignStore((s) => s.artboards)
  const select = useDesignStore((s) => s.select)
  const setScope = useDesignStore((s) => s.setScope)
  const commit = useDesignStore((s) => s.commit)
  const selectedArtboardId = useDesignStore((s) => s.selection.artboardId)
  const textEditingArtboardId = useDesignStore((s) => s.textEditing?.artboardId ?? null)
  const previewArtboardId = useDesignStore((s) => s.previewArtboardId)
  const agentActivity = useDesignStore((s) => s.agentActivity)

  const pageArtboards = Object.values(artboards)
    .filter((a) => a.meta.pageId === pageId)
    .sort((a, b) => a.meta.position - b.meta.position)
    .map((a) => a.meta)
  const pageArtboardIds = pageArtboards.map((m) => m.id)

  // Selected / being edited / previewed / touched by an agent: always live.
  const mounted = new Set(
    stage.w === 0
      ? pageArtboardIds
      : visibleArtboardIds(pageArtboards, viewport, stage, LAZY_MOUNT_MARGIN),
  )
  for (const id of [selectedArtboardId, textEditingArtboardId, previewArtboardId]) {
    if (id) mounted.add(id)
  }
  for (const id of Object.keys(agentActivity)) mounted.add(id)

  // Stage size feeds zoomTo/fitToContent in the store.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = (): void => {
      const size = { w: el.clientWidth, h: el.clientHeight }
      setStageSize(size)
      setStage(size)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // React registers wheel as passive; preventDefault needs a native listener.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const vp = useDesignStore.getState().viewport
      if (e.ctrlKey || e.metaKey) {
        const bounds = el.getBoundingClientRect()
        const anchor = {
          x: e.clientX - bounds.left,
          y: e.clientY - bounds.top,
        }
        const next = clampStageZoom(vp.zoom * Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY))
        setViewport(zoomAt(vp, next, anchor))
        return
      }
      const dx = e.shiftKey ? e.deltaY : e.deltaX
      const dy = e.shiftKey ? 0 : e.deltaY
      setViewport({ x: vp.x - dx, y: vp.y - dy, zoom: vp.zoom })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setViewport])

  // Space = temporary hand tool; the previous tool comes back on keyup.
  useEffect(() => {
    let previous: DesignTool | null = null
    const onDown = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat || isTypingTarget(e.target)) return
      const state = useDesignStore.getState()
      if (state.textEditing || state.mode !== 'edit') return
      e.preventDefault()
      previous = state.tool
      setTool('hand')
    }
    const onUp = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || previous === null) return
      setTool(previous)
      previous = null
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [setTool])

  const localPoint = useCallback((e: ReactPointerEvent): Point => {
    const bounds = containerRef.current!.getBoundingClientRect()
    return { x: e.clientX - bounds.left, y: e.clientY - bounds.top }
  }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (mode !== 'edit') return
    containerRef.current?.focus({ preventScroll: true })
    const point = localPoint(e)
    const wantsPan = e.button === 1 || tool === 'hand'
    if (wantsPan) {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      gestureRef.current = { kind: 'pan', pointerId: e.pointerId, last: point }
      return
    }
    // Only the empty canvas starts a marquee; artboard layers stop propagation.
    if (e.button !== 0 || e.target !== e.currentTarget) return
    if (tool !== 'move') return
    e.currentTarget.setPointerCapture(e.pointerId)
    gestureRef.current = {
      kind: 'marquee',
      pointerId: e.pointerId,
      origin: point,
      current: point,
      additive: e.shiftKey,
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gestureRef.current
    if (!g || g.pointerId !== e.pointerId) return
    const point = localPoint(e)
    if (g.kind === 'pan') {
      const vp = useDesignStore.getState().viewport
      setViewport({
        x: vp.x + point.x - g.last.x,
        y: vp.y + point.y - g.last.y,
        zoom: vp.zoom,
      })
      g.last = point
      return
    }
    g.current = point
    const rect = rectFromPoints(g.origin, g.current)
    setMarquee(rect.w > MARQUEE_THRESHOLD_PX || rect.h > MARQUEE_THRESHOLD_PX ? rect : null)
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gestureRef.current
    if (!g || g.pointerId !== e.pointerId) return
    gestureRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (g.kind === 'pan') return
    setMarquee(null)
    const rect = rectFromPoints(g.origin, g.current)
    const vp = useDesignStore.getState().viewport
    const hits = pageArtboardIds.filter((id) =>
      rectsIntersect(rect, artboardScreenRect(artboards[id].meta, vp)),
    )
    if (rect.w <= MARQUEE_THRESHOLD_PX && rect.h <= MARQUEE_THRESHOLD_PX) {
      // Plain click on empty canvas.
      if (!g.additive) {
        select(null)
        setScope(null)
      }
      return
    }
    // The selection model holds one artboard: multi-artboard marquee is a
    // store extension for a later wave. Until then the first hit wins.
    if (hits.length > 0) {
      select(hits[0], [])
      setScope(null)
    } else if (!g.additive) {
      select(null)
      setScope(null)
    }
  }

  const onDrop = async (e: React.DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault()
    if (!docId) return
    const file = Array.from(e.dataTransfer.files).find((f) => IMAGE_MIMES.has(f.type))
    if (!file) return
    const bounds = e.currentTarget.getBoundingClientRect()
    const canvasPoint = screenToCanvas(
      { x: e.clientX - bounds.left, y: e.clientY - bounds.top },
      viewport,
    )
    const targetId = pageArtboardIds.find((id) =>
      rectContains(artboardBounds(artboards[id].meta), canvasPoint),
    )
    if (!targetId) return
    const target = artboards[targetId]
    const asset = await window.api.design.assetUpload({
      docId,
      name: file.name,
      mime: file.type as DesignAssetMime,
      dataBase64: await readAsBase64(file),
    })
    const width = asset.width ?? 200
    const node: DesignNode = {
      id: newNodeId(),
      tag: 'img',
      kind: 'image',
      style: {
        position: 'absolute',
        left: `${Math.round(canvasPoint.x - target.meta.x)}px`,
        top: `${Math.round(canvasPoint.y - target.meta.y)}px`,
        width: `${Math.min(width, target.meta.width)}px`,
      },
      attrs: { src: asset.url, alt: file.name },
      children: [],
    }
    commit(
      targetId,
      [
        {
          type: 'insert',
          parentId: target.tree.id,
          index: target.tree.children.length,
          node,
        },
      ],
      {
        summary: `Insert image ${file.name}`,
      },
    )
    select(targetId, [node.id])
  }

  const panning = gestureRef.current?.kind === 'pan'
  const cursor = panning ? 'grabbing' : CURSOR[tool]
  const gridSize = GRID_STEP * viewport.zoom

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="relative h-full w-full overflow-hidden outline-none"
      style={{
        cursor,
        background: 'var(--color-bg)',
        backgroundImage:
          'radial-gradient(color-mix(in srgb, var(--color-border) 70%, transparent) 1px, transparent 1px)',
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => void onDrop(e)}
    >
      <div
        className="absolute left-0 top-0"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          transformOrigin: '0 0',
          willChange: 'transform',
        }}
      >
        {pageArtboardIds.map((id) =>
          mounted.has(id) ? (
            <ArtboardFrame key={id} artboardId={id} />
          ) : (
            <ArtboardPlaceholder key={id} artboardId={id} />
          ),
        )}
      </div>

      <SelectionOverlay marquee={marquee} />

      {docId && pageArtboardIds.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto">
            <EmptyState variant="no-artboards" />
          </div>
        </div>
      )}
    </div>
  )
}
