// Screen-space SVG drawn over the whole stage: hover, selection box with
// handles, the selected artboard's outline, the canvas marquee
// and the in-flight gesture feedback (snap guides, flex insertion line, drop
// target, in-artboard marquee, draw preview). Node rects come from each
// bridge's cache (non-reactive), so the overlay subscribes to bridge rect
// events and re-renders on a tick. The agent's in-place presence (veil +
// pill) is AgentOverlay, mounted alongside.

import { useEffect, useReducer } from 'react'
import { getBridge, useDesignStore } from '@/store/designStore'
import type { Rect } from '@shared/design/protocol'
import {
  artboardRectToScreen,
  artboardScreenRect,
  artboardToScreen,
  type ArtboardPlacement,
  type Viewport,
} from './geometry'
import { handleCenters } from './drag-plan'
import { useGestureFeedback } from './interaction-state'
import { AgentOverlay } from './AgentOverlay'

interface Props {
  marquee: Rect | null
}

const HANDLE_SIZE = 8
const ACCENT = 'var(--color-accent)'
const ACCENT_FILL = 'color-mix(in srgb, var(--color-accent) 10%, transparent)'

function nodeScreenRect(artboardId: string, nodeId: string, vp: Viewport): Rect | null {
  const meta = useDesignStore.getState().artboards[artboardId]?.meta
  const rect = getBridge(artboardId)?.getCachedRect(nodeId)
  if (!meta || !rect) return null
  return artboardRectToScreen(rect, meta, vp)
}

function MarqueeRect({ rect }: { rect: Rect }) {
  return (
    <rect
      x={rect.x}
      y={rect.y}
      width={rect.w}
      height={rect.h}
      fill={ACCENT_FILL}
      stroke={ACCENT}
      strokeWidth={1}
    />
  )
}

// Guides, insertion line, drop target, local marquee and draw preview of the
// gesture in flight, converted from artboard-local to screen space.
function GestureLayer({ viewport }: { viewport: Viewport }) {
  const fb = useGestureFeedback()
  const meta = useDesignStore((s) =>
    fb.artboardId ? (s.artboards[fb.artboardId]?.meta ?? null) : null,
  )
  if (!fb.active || !meta) return null
  const toScreen = (r: Rect): Rect => artboardRectToScreen(r, meta, viewport)
  const pt = (x: number, y: number) => artboardToScreen({ x, y }, viewport, meta)
  const drop = fb.dropTarget ? toScreen(fb.dropTarget) : null
  const ins = fb.insertion
  const a = ins ? pt(ins.x1, ins.y1) : null
  const b = ins ? pt(ins.x2, ins.y2) : null
  return (
    <g>
      {drop && (
        <rect
          x={drop.x}
          y={drop.y}
          width={drop.w}
          height={drop.h}
          fill={ACCENT_FILL}
          stroke={ACCENT}
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
      )}
      {fb.guides.map((g, i) => {
        const p1 = g.axis === 'x' ? pt(g.at, g.from) : pt(g.from, g.at)
        const p2 = g.axis === 'x' ? pt(g.at, g.to) : pt(g.to, g.at)
        return (
          <line
            key={`guide-${i}`}
            x1={p1.x}
            y1={p1.y}
            x2={p2.x}
            y2={p2.y}
            stroke="var(--color-danger, var(--color-accent))"
            strokeWidth={1}
            strokeDasharray="4 2"
          />
        )
      })}
      {a && b && (
        <line
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          stroke={ACCENT}
          strokeWidth={3}
          strokeLinecap="round"
        />
      )}
      {fb.marquee && <MarqueeRect rect={toScreen(fb.marquee)} />}
      {fb.drawing && (
        <rect
          x={toScreen(fb.drawing).x}
          y={toScreen(fb.drawing).y}
          width={toScreen(fb.drawing).w}
          height={toScreen(fb.drawing).h}
          fill="none"
          stroke={ACCENT}
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      )}
    </g>
  )
}

function hoverScreenRect(vp: Viewport): Rect | null {
  const { hover, selection, artboards } = useDesignStore.getState()
  if (!hover) return null
  if (selection.artboardId === hover.artboardId && selection.nodeIds.includes(hover.nodeId))
    return null
  const meta: ArtboardPlacement | undefined = artboards[hover.artboardId]?.meta
  return meta ? artboardRectToScreen(hover.rect, meta, vp) : null
}

export function SelectionOverlay({ marquee }: Props) {
  const [, bump] = useReducer((n: number) => n + 1, 0)

  const viewport = useDesignStore((s) => s.viewport)
  const selection = useDesignStore((s) => s.selection)
  const hover = useDesignStore((s) => s.hover)
  const textEditing = useDesignStore((s) => s.textEditing)
  const mode = useDesignStore((s) => s.mode)
  const gestureActive = useGestureFeedback((s) => s.active)
  const selectedMeta = useDesignStore((s) =>
    s.selection.artboardId ? (s.artboards[s.selection.artboardId]?.meta ?? null) : null,
  )
  const selectedReady = useDesignStore((s) =>
    s.selection.artboardId ? (s.artboards[s.selection.artboardId]?.ready ?? false) : false,
  )

  const watchedId = selection.artboardId

  // Rect cache changes are not React state: listen and tick.
  useEffect(() => {
    const bridge = watchedId ? getBridge(watchedId) : undefined
    if (!bridge) return
    const offs = [
      bridge.on('rects', bump),
      bridge.on('rectsChanged', bump),
      bridge.on('rendered', bump),
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [watchedId, selectedReady])

  if (mode !== 'edit') return null

  const selectedNodeRects = selection.artboardId
    ? selection.nodeIds
        .map((id) => ({
          id,
          rect: nodeScreenRect(selection.artboardId!, id, viewport),
        }))
        .filter((x): x is { id: string; rect: Rect } => x.rect !== null)
    : []

  const hoverRect = hover && !gestureActive ? hoverScreenRect(viewport) : null

  const artboardOutline = selectedMeta ? artboardScreenRect(selectedMeta, viewport) : null
  const editingNodeId =
    textEditing?.artboardId === selection.artboardId ? textEditing?.nodeId : null

  return (
    <>
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        aria-hidden
      >
        {artboardOutline && (
          <rect
            x={artboardOutline.x - 0.5}
            y={artboardOutline.y - 0.5}
            width={artboardOutline.w + 1}
            height={artboardOutline.h + 1}
            fill="none"
            stroke={ACCENT}
            strokeWidth={selection.nodeIds.length === 0 ? 2 : 1}
            strokeOpacity={selection.nodeIds.length === 0 ? 1 : 0.5}
          />
        )}

        {hoverRect && (
          <rect
            x={hoverRect.x}
            y={hoverRect.y}
            width={hoverRect.w}
            height={hoverRect.h}
            fill="none"
            stroke={ACCENT}
            strokeWidth={1}
          />
        )}

        {selectedNodeRects.map(({ id, rect }) => (
          <g key={id}>
            <rect
              x={rect.x}
              y={rect.y}
              width={rect.w}
              height={rect.h}
              fill="none"
              stroke={ACCENT}
              strokeWidth={2}
            />
            {id !== editingNodeId &&
              !gestureActive &&
              handleCenters(rect).map(([handle, hx, hy]) => (
                <rect
                  key={handle}
                  x={hx - HANDLE_SIZE / 2}
                  y={hy - HANDLE_SIZE / 2}
                  width={HANDLE_SIZE}
                  height={HANDLE_SIZE}
                  fill="var(--color-surface)"
                  stroke={ACCENT}
                  strokeWidth={1.5}
                />
              ))}
          </g>
        ))}

        <GestureLayer viewport={viewport} />

        {marquee && <MarqueeRect rect={marquee} />}
      </svg>
      <AgentOverlay />
    </>
  )
}
