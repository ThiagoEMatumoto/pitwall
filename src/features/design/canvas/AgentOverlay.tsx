// In-place "Claude is editing" indicator: a shimmering veil over each node
// the agent is touching plus a pill naming the action, anchored to the
// node's top-left. A whole-artboard target (write_html replace, fresh
// artboard) veils the artboard, takes over its label and shows a skeleton
// while the tree is still empty. Screen-space HTML over the stage, never
// interactive. SelectionOverlay mounts it in edit mode only.

import { useEffect, useReducer, useRef } from 'react'
import { Sparkles } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { getBridge, getNodeIndex, useDesignStore } from '@/store/designStore'
import type { Rect } from '@shared/design/protocol'
import type { DesignState } from '@/store/designStore.types'
import { rowLabel } from '../sidebar/LayerRow'
import { artboardRectToScreen, artboardScreenRect, type Viewport } from './geometry'
import {
  FADE_OUT_MS,
  presenceStage,
  presenceTargets,
  presenceText,
  reconcilePresence,
  type PresenceItem,
  type PresenceStage,
} from './agent-presence'

// Stage transitions (enter → steady → done → leave) are time-driven.
const TICK_MS = 100
const PILL_HEIGHT = 20
const PILL_GAP = 2

interface Placed {
  item: PresenceItem
  rect: Rect
  artboardRect: Rect
  name: string
  whole: boolean
  skeleton: boolean
}

// The node's own rect, else the nearest ancestor that has one (a fragment
// being inserted has no DOM yet), else the artboard itself.
function nodeRect(s: DesignState, artboardId: string, nodeId: string, vp: Viewport): Rect | null {
  const meta = s.artboards[artboardId]?.meta
  const bridge = getBridge(artboardId)
  const index = getNodeIndex(artboardId)
  if (!meta || !bridge) return null
  let id: string | null = nodeId
  while (id) {
    const rect = bridge.getCachedRect(id)
    if (rect) return artboardRectToScreen(rect, meta, vp)
    id = index?.get(id)?.parentId ?? null
  }
  return null
}

function place(s: DesignState, item: PresenceItem, vp: Viewport): Placed | null {
  const ab = s.artboards[item.artboardId]
  if (!ab) return null
  const artboardRect = artboardScreenRect(ab.meta, vp)
  const whole = item.nodeId === null || item.nodeId === ab.tree.id
  if (whole) {
    return {
      item,
      rect: artboardRect,
      artboardRect,
      name: ab.meta.name,
      whole,
      skeleton: item.doneAt === null && ab.tree.children.length === 0,
    }
  }
  const entry = getNodeIndex(item.artboardId)?.get(item.nodeId!)
  const name = entry ? rowLabel(entry.node) : item.nodeId!
  const rect = nodeRect(s, item.artboardId, item.nodeId!, vp) ?? artboardRect
  return { item, rect, artboardRect, name, whole, skeleton: false }
}

function Skeleton({ rect }: { rect: Rect }) {
  const width = Math.min(rect.w * 0.6, 320)
  const bar = Math.max(6, Math.min(12, rect.h * 0.04))
  return (
    <div
      className="absolute flex flex-col"
      style={{
        left: rect.x + rect.w * 0.2,
        top: rect.y + rect.h * 0.3,
        width,
        gap: bar,
      }}
    >
      {[1, 0.75, 0.5].map((f, i) => (
        <div
          key={i}
          className="pw-agent-skeleton rounded-full"
          style={{
            width: `${f * 100}%`,
            height: bar,
            background: 'color-mix(in srgb, var(--color-accent) 28%, transparent)',
            animationDelay: `${i * 160}ms`,
          }}
        />
      ))}
    </div>
  )
}

function Pill({ placed, stage }: { placed: Placed; stage: PresenceStage }) {
  const { item, rect, artboardRect, name, whole } = placed
  const done = stage === 'done' || stage === 'leave'
  // Whole-artboard: sit on the artboard's label line. Node: just above the
  // node when there is room inside the artboard, else tucked in its corner.
  const above = whole || rect.y - artboardRect.y >= PILL_HEIGHT + PILL_GAP
  const top = above ? rect.y - PILL_HEIGHT - PILL_GAP : rect.y + PILL_GAP
  const tone = done ? 'var(--color-success)' : 'var(--color-accent)'
  return (
    <div
      className="absolute flex items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] font-medium leading-5"
      style={{
        left: whole ? rect.x : rect.x + (above ? 0 : PILL_GAP),
        top,
        height: PILL_HEIGHT,
        maxWidth: Math.max(120, rect.w),
        color: tone,
        background: `color-mix(in srgb, ${tone} 14%, var(--color-surface))`,
        boxShadow: `0 0 0 1px color-mix(in srgb, ${tone} 40%, transparent)`,
      }}
    >
      <Icon as={Sparkles} size={11} className="shrink-0" />
      <span className="truncate">{presenceText(item, name, stage)}</span>
    </div>
  )
}

function Presence({ placed, now }: { placed: Placed; now: number }) {
  const stage = presenceStage(placed.item, now)
  const leaving = stage === 'leave'
  const { rect } = placed
  return (
    <div
      className={stage === 'enter' ? 'pw-agent-in' : undefined}
      style={{
        opacity: leaving ? 0 : 1,
        transition: `opacity ${FADE_OUT_MS}ms ease-out`,
      }}
    >
      {!(stage === 'done' || leaving) && (
        <div
          className="pw-agent-veil absolute"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        />
      )}
      {placed.skeleton && stage !== 'done' && !leaving && <Skeleton rect={rect} />}
      <Pill placed={placed} stage={stage} />
    </div>
  )
}

export function AgentOverlay() {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const itemsRef = useRef<PresenceItem[]>([])
  const activity = useDesignStore((s) => s.agentActivity)
  const viewport = useDesignStore((s) => s.viewport)
  const artboards = useDesignStore((s) => s.artboards)
  const pageId = useDesignStore((s) => s.pageId)

  const now = Date.now()
  const pageArtboardIds = Object.values(artboards)
    .filter((a) => a.meta.pageId === pageId)
    .map((a) => a.meta.id)
  itemsRef.current = reconcilePresence(
    itemsRef.current,
    presenceTargets(activity, pageArtboardIds, now),
    now,
  )
  const items = itemsRef.current
  const hasItems = items.length > 0
  const watchedKey = [...new Set(items.map((i) => i.artboardId))].join('|')

  useEffect(() => {
    if (!hasItems) return
    const timer = setInterval(bump, TICK_MS)
    return () => clearInterval(timer)
  }, [hasItems])

  // Node rects live in the bridge cache, not in React state: tick on change.
  useEffect(() => {
    const offs = watchedKey
      .split('|')
      .filter(Boolean)
      .flatMap((id) => {
        const bridge = getBridge(id)
        if (!bridge) return []
        return [
          bridge.on('rects', bump),
          bridge.on('rectsChanged', bump),
          bridge.on('rendered', bump),
        ]
      })
    return () => {
      for (const off of offs) off()
    }
  }, [watchedKey])

  if (!hasItems) return null
  const state = useDesignStore.getState()
  const placedItems = items
    .map((item) => place(state, item, viewport))
    .filter((p): p is Placed => p !== null)

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {placedItems.map((p) => (
        <Presence key={p.item.key} placed={p} now={now} />
      ))}
    </div>
  )
}
