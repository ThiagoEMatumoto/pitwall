// Agent activity per document and "what changed since your visit". Main keeps
// the authoritative copy (live-state.ts) while this renderer is not watching
// (Design area unmounted), so every (re)entry hydrates from design:live-state.

import { api } from '@/lib/ipc'
import type { DesignAgentActivity, DesignLiveState } from '@shared/types/design'
import type { DesignStore } from './designStore.internal'

// Keyed by artboardId; '*' holds document-level activity.
export type ActivityMap = Record<string, DesignAgentActivity[]>

const LAST_SEEN_KEY = 'pitwall.design.lastSeenAt'

export function loadLastSeen(): Record<string, number> {
  try {
    const raw = globalThis.localStorage?.getItem(LAST_SEEN_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function persistLastSeen(map: Record<string, number>): void {
  try {
    globalThis.localStorage?.setItem(LAST_SEEN_KEY, JSON.stringify(map))
  } catch {
    // Quota or disabled storage: the banner just shows again next visit.
  }
}

export function reduceActivity(current: ActivityMap, a: DesignAgentActivity): ActivityMap {
  const key = a.artboardId ?? '*'
  if (a.phase === 'finish') {
    if (a.artboardId === null) return {}
    const { [key]: _gone, ...rest } = current
    return rest
  }
  // 'end' replaces the matching 'start' so the overlay keeps one row per
  // call. A call may end on a different key than it started (an artboard
  // create starts at the document and ends on the artboard it made), so the
  // start is retired wherever it lives — else it veils every artboard until
  // it goes stale.
  const sameCall = (x: DesignAgentActivity) => x.tool === a.tool && x.sessionId === a.sessionId
  const next: ActivityMap = {}
  for (const [k, list] of Object.entries(current)) {
    const kept = list.filter((x) => !(sameCall(x) && (k === key || x.phase === 'start')))
    if (kept.length) next[k] = kept
  }
  // Document-level writes are instantaneous and nothing waits for
  // design_nodes_finish on them (main clears them on 'end' too).
  if (a.phase === 'end' && a.artboardId === null) return next
  return { ...next, [key]: [...(next[key] ?? []), a] }
}

function groupActivity(list: DesignAgentActivity[]): ActivityMap {
  const out: ActivityMap = {}
  for (const a of list) {
    const key = a.artboardId ?? '*'
    out[key] = [...(out[key] ?? []), a]
  }
  return out
}

// Mutates `map`: callers pass their own fresh copy.
function noteFinish(map: Record<string, number>, a: DesignAgentActivity): void {
  if (a.phase === 'finish' && a.at > (map[a.docId] ?? 0)) map[a.docId] = a.at
}

export function recordFinish(store: DesignStore, a: DesignAgentActivity): void {
  store.setState((s) => {
    const lastFinishAt = { ...s.lastFinishAt }
    noteFinish(lastFinishAt, a)
    return { lastFinishAt }
  })
}

// `agentActivity` stays the open document's slice so the canvas components
// keep reading one flat map.
export function setDocActivity(store: DesignStore, docId: string, next: ActivityMap): void {
  store.setState((s) => {
    const { [docId]: _old, ...others } = s.activityByDoc
    const activityByDoc = Object.keys(next).length ? { ...others, [docId]: next } : others
    return docId === s.docId ? { activityByDoc, agentActivity: next } : { activityByDoc }
  })
}

// No docId: replaces every document's activity with main's snapshot (a
// document missing from it has nothing in flight).
export async function hydrateLiveState(store: DesignStore, docId?: string): Promise<void> {
  let states: DesignLiveState[]
  try {
    states = await api.design.liveState(docId)
  } catch {
    return
  }
  store.setState((s) => {
    const activityByDoc: Record<string, ActivityMap> = docId ? { ...s.activityByDoc } : {}
    if (docId) delete activityByDoc[docId]
    const lastFinishAt = { ...s.lastFinishAt }
    for (const st of states) {
      const grouped = groupActivity(st.activity)
      if (Object.keys(grouped).length) activityByDoc[st.docId] = grouped
      for (const c of st.changes) noteFinish(lastFinishAt, c)
    }
    const open = s.docId
    if (!open || (docId && docId !== open)) return { activityByDoc, lastFinishAt }
    const seen = s.lastSeenAt[open] ?? 0
    const changes = states.find((st) => st.docId === open)?.changes ?? []
    return {
      activityByDoc,
      lastFinishAt,
      agentActivity: activityByDoc[open] ?? {},
      unseenChanges: changes.filter((c) => c.at > seen),
    }
  })
}

export function markSeen(store: DesignStore, docId: string, now = Date.now()): void {
  store.setState((s) => {
    const lastSeenAt = { ...s.lastSeenAt, [docId]: now }
    persistLastSeen(lastSeenAt)
    return docId === s.docId ? { lastSeenAt, unseenChanges: [] } : { lastSeenAt }
  })
}
