// Agent-activity toasts of the Design Studio share ONE slot: a burst of
// patches across four artboards used to stack eight "Claude atualizou" /
// "Claude terminou" toasts over the inspector. Every new event replaces
// the live toast and folds the artboard into its title instead.
// No store import here: designStore.internal calls in, and it must not
// import the store back.

import { dismissToast, showToast } from '@/features/notifications/toast-store'

export type AgentToastKind = 'update' | 'finish'

interface Slot {
  id: number
  kind: AgentToastKind
  shownAt: number
  names: Map<string, string>
}

// Matches the toast store default: after it the slot is gone from screen and
// a new event starts a fresh title instead of re-listing old artboards.
const SLOT_WINDOW_MS = 6000

let slot: Slot | null = null

const VERB: Record<AgentToastKind, string> = {
  update: 'atualizou',
  finish: 'terminou',
}

function title(kind: AgentToastKind, names: readonly string[]): string {
  if (names.length === 1) return `Claude ${VERB[kind]} "${names[0]}"`
  return `Claude ${VERB[kind]} ${names.length} artboards`
}

export function showAgentToast(
  kind: AgentToastKind,
  artboardId: string,
  name: string,
  onView: () => void,
  now = Date.now(),
): number {
  const live = slot && slot.kind === kind && now - slot.shownAt < SLOT_WINDOW_MS ? slot : null
  const names = new Map(live?.names ?? [])
  names.set(artboardId, name)
  if (slot) dismissToast(slot.id)
  const list = [...names.values()]
  const id = showToast({
    title: title(kind, list),
    body: list.length > 1 ? list.join(' · ') : undefined,
    actionLabel: 'Ver',
    onAction: onView,
  })
  slot = { id, kind, shownAt: now, names }
  return id
}

export function resetAgentToasts(): void {
  slot = null
}
