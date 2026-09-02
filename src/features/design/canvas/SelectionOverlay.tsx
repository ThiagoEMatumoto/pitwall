// Screen-space SVG drawn over the whole stage: hover, selection box with
// handles, the selected artboard's outline/name, agent shimmer and the
// marquee. Node rects come from each bridge's cache (non-reactive), so the
// overlay subscribes to bridge rect events and re-renders on a tick.

import { useEffect, useReducer } from 'react'
import { getBridge, useDesignStore } from '@/store/designStore'
import type { Rect } from '@shared/design/protocol'
import { artboardRectToScreen, artboardScreenRect, type Viewport } from './geometry'

interface Props {
  marquee: Rect | null
}

const HANDLE_SIZE = 8

// 8 handles: corners + edge midpoints. Wave 3 gives each a resize cursor.
function handleCenters(r: Rect): Array<[number, number]> {
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  return [
    [r.x, r.y],
    [cx, r.y],
    [r.x + r.w, r.y],
    [r.x, cy],
    [r.x + r.w, cy],
    [r.x, r.y + r.h],
    [cx, r.y + r.h],
    [r.x + r.w, r.y + r.h],
  ]
}

function nodeScreenRect(artboardId: string, nodeId: string, vp: Viewport): Rect | null {
  const meta = useDesignStore.getState().artboards[artboardId]?.meta
  const rect = getBridge(artboardId)?.getCachedRect(nodeId)
  if (!meta || !rect) return null
  return artboardRectToScreen(rect, meta, vp)
}

export function SelectionOverlay({ marquee }: Props) {
  const [, bump] = useReducer((n: number) => n + 1, 0)

  const viewport = useDesignStore((s) => s.viewport)
  const selection = useDesignStore((s) => s.selection)
  const hover = useDesignStore((s) => s.hover)
  const textEditing = useDesignStore((s) => s.textEditing)
  const agentActivity = useDesignStore((s) => s.agentActivity)
  const mode = useDesignStore((s) => s.mode)
  const selectedMeta = useDesignStore((s) =>
    s.selection.artboardId ? (s.artboards[s.selection.artboardId]?.meta ?? null) : null,
  )
  const selectedReady = useDesignStore((s) =>
    s.selection.artboardId ? (s.artboards[s.selection.artboardId]?.ready ?? false) : false,
  )

  const agentArtboardIds = Object.keys(agentActivity).filter((k) => k !== '*')
  const watchedKey = [selection.artboardId ?? '', ...agentArtboardIds].join('|')

  // Rect cache changes are not React state: listen and tick.
  useEffect(() => {
    const ids = watchedKey.split('|').filter(Boolean)
    const offs = ids.flatMap((id) => {
      const bridge = getBridge(id)
      if (!bridge) return []
      return [bridge.on('rects', bump), bridge.on('rectsChanged', bump), bridge.on('rendered', bump)]
    })
    return () => {
      for (const off of offs) off()
    }
  }, [watchedKey, selectedReady])

  if (mode !== 'edit') return null

  const selectedNodeRects = selection.artboardId
    ? selection.nodeIds
        .map((id) => ({
          id,
          rect: nodeScreenRect(selection.artboardId!, id, viewport),
        }))
        .filter((x): x is { id: string; rect: Rect } => x.rect !== null)
    : []

  const hoverRect =
    hover &&
    !(selection.artboardId === hover.artboardId && selection.nodeIds.includes(hover.nodeId)) &&
    useDesignStore.getState().artboards[hover.artboardId]
      ? artboardRectToScreen(hover.rect, useDesignStore.getState().artboards[hover.artboardId].meta, viewport)
      : null

  const agentRects = agentArtboardIds.flatMap((artboardId) =>
    (agentActivity[artboardId] ?? [])
      .flatMap((a) => a.nodeIds)
      .map((id) => nodeScreenRect(artboardId, id, viewport))
      .filter((r): r is Rect => r !== null),
  )

  const artboardOutline = selectedMeta ? artboardScreenRect(selectedMeta, viewport) : null
  const editingNodeId = textEditing?.artboardId === selection.artboardId ? textEditing?.nodeId : null

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden>
      {artboardOutline && (
        <rect
          x={artboardOutline.x - 0.5}
          y={artboardOutline.y - 0.5}
          width={artboardOutline.w + 1}
          height={artboardOutline.h + 1}
          fill="none"
          stroke="var(--color-accent)"
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
          stroke="var(--color-accent)"
          strokeWidth={1}
        />
      )}

      {agentRects.map((r, i) => (
        <rect
          key={`agent-${i}`}
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          fill="color-mix(in srgb, var(--color-accent) 12%, transparent)"
          stroke="var(--color-accent)"
          strokeWidth={1.5}
          strokeDasharray="6 4"
        >
          <animate attributeName="stroke-dashoffset" from="0" to="-20" dur="0.8s" repeatCount="indefinite" />
        </rect>
      ))}

      {selectedNodeRects.map(({ id, rect }) => (
        <g key={id}>
          <rect
            x={rect.x}
            y={rect.y}
            width={rect.w}
            height={rect.h}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={2}
          />
          {id !== editingNodeId &&
            handleCenters(rect).map(([hx, hy], i) => (
              <rect
                key={i}
                x={hx - HANDLE_SIZE / 2}
                y={hy - HANDLE_SIZE / 2}
                width={HANDLE_SIZE}
                height={HANDLE_SIZE}
                fill="var(--color-surface)"
                stroke="var(--color-accent)"
                strokeWidth={1.5}
              />
            ))}
        </g>
      ))}

      {marquee && (
        <rect
          x={marquee.x}
          y={marquee.y}
          width={marquee.w}
          height={marquee.h}
          fill="color-mix(in srgb, var(--color-accent) 10%, transparent)"
          stroke="var(--color-accent)"
          strokeWidth={1}
        />
      )}
    </svg>
  )
}
