// Pure model behind the in-place "Claude is editing" indicator: turns the
// store's agentActivity (one row per tool call) into one presence target per
// node, and keeps targets that just vanished around long enough to fade out.
// No React, no DOM: AgentOverlay feeds it and draws the result.

import type { DesignAgentActivity } from '@shared/types/design'

export const FADE_IN_MS = 150
export const FADE_OUT_MS = 400
// Tool handlers run synchronously in main, so 'start' and 'end' reach the
// renderer back to back: without a floor the veil would never be seen.
export const MIN_ACTIVE_MS = 700
// "Claude terminou" stays readable this long before the fade-out starts.
export const DONE_HOLD_MS = 1200
// A session that dies mid-call never sends 'end'/'finish'.
export const PRESENCE_STALE_MS = 30_000

const ACTION_LABELS: Record<string, string> = {
  design_styles_update: 'ajustando estilo',
  design_text_set: 'escrevendo texto',
  design_write_html: 'escrevendo',
  design_nodes_move: 'movendo',
  design_nodes_duplicate: 'duplicando',
  design_nodes_delete: 'removendo',
  design_nodes_rename: 'renomeando',
  design_tokens_set: 'atualizando tokens',
  design_artboard_create: 'criando artboard',
  design_link_set: 'ligando telas',
}

export function actionLabel(tool: string): string {
  return ACTION_LABELS[tool] ?? tool.replace(/^design_/, '').replace(/_/g, ' ')
}

export type PresencePhase = 'active' | 'done'

export interface PresenceTarget {
  // `${artboardId}:${nodeId ?? '*'}`
  key: string
  artboardId: string
  // null = the whole artboard (write_html replace, new artboard, doc-level).
  nodeId: string | null
  tool: string
  phase: PresencePhase
  at: number
}

export interface PresenceItem extends PresenceTarget {
  startedAt: number
  doneAt: number | null
}

export type PresenceStage = 'enter' | 'steady' | 'done' | 'leave'

export function presenceKey(artboardId: string, nodeId: string | null): string {
  return `${artboardId}:${nodeId ?? '*'}`
}

function keepLatest(map: Map<string, PresenceTarget>, t: PresenceTarget): void {
  const cur = map.get(t.key)
  if (!cur) {
    map.set(t.key, t)
    return
  }
  // Newer wins; on the same tick an in-flight call beats a finished one.
  const newer = t.at > cur.at || (t.at === cur.at && t.phase === 'active' && cur.phase === 'done')
  if (newer) map.set(t.key, t)
}

function fresh(t: PresenceTarget, now: number): boolean {
  const age = now - t.at
  return t.phase === 'active'
    ? age < PRESENCE_STALE_MS
    : age < MIN_ACTIVE_MS + DONE_HOLD_MS + FADE_OUT_MS
}

// One target per (artboard, node). Document-level activity ('*' key, e.g.
// tokens) lands on every artboard of the page as a whole-artboard target.
export function presenceTargets(
  activity: Record<string, DesignAgentActivity[]>,
  artboardIds: readonly string[],
  now: number,
): PresenceTarget[] {
  const map = new Map<string, PresenceTarget>()
  for (const [key, entries] of Object.entries(activity)) {
    for (const a of entries) {
      if (a.phase === 'finish') continue
      const phase: PresencePhase = a.phase === 'start' ? 'active' : 'done'
      const boards = key === '*' ? artboardIds : [key]
      for (const artboardId of boards) {
        const nodeIds = key === '*' || a.nodeIds.length === 0 ? [null] : a.nodeIds
        for (const nodeId of nodeIds) {
          keepLatest(map, {
            key: presenceKey(artboardId, nodeId),
            artboardId,
            nodeId,
            tool: a.tool,
            phase,
            at: a.at,
          })
        }
      }
    }
  }
  return [...map.values()].filter((t) => fresh(t, now))
}

export function isExpired(item: PresenceItem, now: number): boolean {
  return item.doneAt !== null && now - item.doneAt >= DONE_HOLD_MS + FADE_OUT_MS
}

// The moment a target may show "terminou": never before it has been active
// for MIN_ACTIVE_MS, so a synchronous call still reads as an edit.
function doneAfter(startedAt: number, endedAt: number): number {
  return Math.max(endedAt, startedAt + MIN_ACTIVE_MS)
}

// Carries state across ticks: a target that disappeared (design_nodes_finish
// drops the rows) becomes done now and lingers until it has faded out.
export function reconcilePresence(
  prev: readonly PresenceItem[],
  targets: readonly PresenceTarget[],
  now: number,
): PresenceItem[] {
  const before = new Map(prev.map((p) => [p.key, p]))
  const seen = new Set<string>()
  const next: PresenceItem[] = []
  for (const t of targets) {
    seen.add(t.key)
    const old = before.get(t.key)
    if (t.phase === 'active') {
      const startedAt = old && old.doneAt === null ? old.startedAt : now
      next.push({ ...t, startedAt, doneAt: null })
    } else {
      const startedAt = old?.startedAt ?? t.at
      const doneAt = old?.doneAt ?? doneAfter(startedAt, Math.min(t.at, now))
      next.push({ ...t, startedAt, doneAt })
    }
  }
  for (const old of prev) {
    if (seen.has(old.key)) continue
    const gone: PresenceItem =
      old.doneAt === null ? { ...old, phase: 'done', doneAt: doneAfter(old.startedAt, now) } : old
    if (!isExpired(gone, now)) next.push(gone)
  }
  return next
}

export function presenceStage(item: PresenceItem, now: number): PresenceStage {
  if (item.doneAt === null || now < item.doneAt) {
    return now - item.startedAt < FADE_IN_MS ? 'enter' : 'steady'
  }
  return now - item.doneAt < DONE_HOLD_MS ? 'done' : 'leave'
}

// `whole` = the target is the artboard itself (null node or its root).
export function presenceText(
  item: PresenceItem,
  name: string,
  stage: PresenceStage,
  whole = item.nodeId === null,
): string {
  if (stage === 'done' || stage === 'leave') return 'Claude terminou'
  if (whole) return `Claude está ${actionLabel(item.tool)} ${name}…`
  return `Claude · ${actionLabel(item.tool)} · ${name}`
}
