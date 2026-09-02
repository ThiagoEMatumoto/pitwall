import type { DesignAgentActivity, DesignSelection } from '../../../../shared/types/design'

// Ephemeral Design Studio state, in main-process memory only: what the human
// has selected (read by design_selection_get on the MCP side), which document
// is open and what the agent is touching right now (HUD on the canvas). None
// of it survives a restart nor has any reason to go to the database.

export interface LiveSelection {
  artboardId: string | null
  nodeIds: string[]
  updatedAt: number
}

// Activity without a `finish` fades on its own: an agent that died halfway
// must not leave the HUD blinking forever.
export const ACTIVITY_TTL_MS = 5 * 60 * 1000

// A runaway agent (or one that never calls finish) must not grow the list
// without bound: the oldest entries are dropped on write.
export const MAX_ACTIVITY_ENTRIES = 200

const selections = new Map<string, LiveSelection>()
const activities = new Map<string, DesignAgentActivity[]>()
let activeDocId: string | null = null

export function setSelection(input: DesignSelection): void {
  selections.set(input.docId, {
    artboardId: input.artboardId,
    nodeIds: [...input.nodeIds],
    updatedAt: Date.now(),
  })
}

export function getSelection(docId: string): LiveSelection | null {
  return selections.get(docId) ?? null
}

export function setActiveDoc(docId: string | null): void {
  activeDocId = docId
}

export function getActiveDoc(): string | null {
  return activeDocId
}

export function setActivity(activity: DesignAgentActivity): void {
  const current = activities.get(activity.docId) ?? []
  const next = [...current, activity]
  activities.set(activity.docId, next.slice(Math.max(0, next.length - MAX_ACTIVITY_ENTRIES)))
}

export function clearActivity(
  docId: string,
  filter?: { artboardId?: string | null; nodeIds?: string[] },
): void {
  if (!filter) {
    activities.delete(docId)
    return
  }
  const current = activities.get(docId) ?? []
  const nodeSet = filter.nodeIds ? new Set(filter.nodeIds) : null
  const kept = current.filter((a) => {
    const artboardHit = filter.artboardId === undefined || a.artboardId === filter.artboardId
    const nodeHit = nodeSet === null || a.nodeIds.some((id) => nodeSet.has(id))
    return !(artboardHit && nodeHit)
  })
  if (kept.length) activities.set(docId, kept)
  else activities.delete(docId)
}

export function listActivity(docId: string, now = Date.now()): DesignAgentActivity[] {
  const current = activities.get(docId) ?? []
  const fresh = current.filter((a) => now - a.at < ACTIVITY_TTL_MS)
  if (fresh.length !== current.length) {
    if (fresh.length) activities.set(docId, fresh)
    else activities.delete(docId)
  }
  return fresh
}

// Tests only: wipes everything between cases.
export function resetLiveState(): void {
  selections.clear()
  activities.clear()
  activeDocId = null
}
