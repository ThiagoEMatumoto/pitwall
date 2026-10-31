import type {
  DesignAgentActivity,
  DesignLiveState,
  DesignSelection,
} from '../../../../shared/types/design'

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

// design_nodes_finish summaries kept per document so a human who was away
// (other area, other document) can be told what changed since the visit.
export const MAX_RECENT_CHANGES = 20

const selections = new Map<string, LiveSelection>()
const activities = new Map<string, DesignAgentActivity[]>()
const changes = new Map<string, DesignAgentActivity[]>()
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

function freshEntries(
  map: Map<string, DesignAgentActivity[]>,
  docId: string,
  now: number,
): DesignAgentActivity[] {
  const current = map.get(docId) ?? []
  const fresh = current.filter((a) => now - a.at < ACTIVITY_TTL_MS)
  if (fresh.length !== current.length) {
    if (fresh.length) map.set(docId, fresh)
    else map.delete(docId)
  }
  return fresh
}

export function listActivity(docId: string, now = Date.now()): DesignAgentActivity[] {
  return freshEntries(activities, docId, now)
}

export function recordChange(finish: DesignAgentActivity): void {
  const next = [...(changes.get(finish.docId) ?? []), finish]
  changes.set(finish.docId, next.slice(Math.max(0, next.length - MAX_RECENT_CHANGES)))
}

export function listChanges(docId: string, now = Date.now()): DesignAgentActivity[] {
  return freshEntries(changes, docId, now)
}

export function forgetDoc(docId: string): void {
  activities.delete(docId)
  changes.delete(docId)
}

// No docId: every document that still has something fresh to report.
export function snapshot(docId?: string, now = Date.now()): DesignLiveState[] {
  const ids = docId ? [docId] : [...new Set([...activities.keys(), ...changes.keys()])]
  const out: DesignLiveState[] = []
  for (const id of ids) {
    const activity = listActivity(id, now)
    const recent = listChanges(id, now)
    if (docId || activity.length || recent.length) {
      out.push({ docId: id, activity, changes: recent })
    }
  }
  return out
}

// Tests only: wipes everything between cases.
export function resetLiveState(): void {
  selections.clear()
  activities.clear()
  changes.clear()
  activeDocId = null
}
