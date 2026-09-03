// Pure preview logic: navigation history, sibling stepping and the active
// transition the player hands to the runtime (View Transitions happen inside
// the iframe; the parent only animates the wrapper size). PreviewMode drives it.

import { viewTransitionName } from '@shared/design/motion'
import type { DesignEasing, DesignNode, DesignTransition } from '@shared/types/design'

export type NavDirection = 'forward' | 'back'

export interface PreviewHistory {
  entries: string[]
  index: number
}

export interface ActiveTransition {
  from: string
  to: string
  kind: DesignTransition
  direction: NavDirection
  // ms, already resolved (link duration or the kind's default).
  duration: number
  // Omitted = the runtime's default for the kind.
  easing?: DesignEasing
}

export interface PreviewNavState {
  history: PreviewHistory
  transition: ActiveTransition | null
}

export const TRANSITION_DURATION_MS: Record<DesignTransition, number> = {
  none: 0,
  fade: 200,
  push: 280,
  smart: 300,
}

export function createHistory(startId: string): PreviewHistory {
  return { entries: [startId], index: 0 }
}

export function currentId(h: PreviewHistory): string {
  return h.entries[h.index]
}

export function canGoBack(h: PreviewHistory): boolean {
  return h.index > 0
}

export function canGoForward(h: PreviewHistory): boolean {
  return h.index < h.entries.length - 1
}

// A link click: drops any forward entries, like a browser.
export function pushHistory(h: PreviewHistory, toId: string): PreviewHistory {
  if (currentId(h) === toId) return h
  return {
    entries: [...h.entries.slice(0, h.index + 1), toId],
    index: h.index + 1,
  }
}

export function backHistory(h: PreviewHistory): PreviewHistory {
  return canGoBack(h) ? { ...h, index: h.index - 1 } : h
}

export function forwardHistory(h: PreviewHistory): PreviewHistory {
  return canGoForward(h) ? { ...h, index: h.index + 1 } : h
}

// Previous/next artboard in page order; null at the edges (no wrap).
export function siblingArtboard(order: readonly string[], id: string, step: 1 | -1): string | null {
  const i = order.indexOf(id)
  if (i === -1) return null
  const j = i + step
  return j >= 0 && j < order.length ? order[j] : null
}

export type PreviewNavAction =
  | {
      type: 'navigate'
      to: string
      transition: DesignTransition
      duration?: number
      easing?: DesignEasing
    }
  | { type: 'back' }
  | { type: 'forward' }
  // Replaces the current entry without animating (external sync, e.g. the
  // store's previewArtboardId changed from outside).
  | { type: 'jump'; to: string }
  | { type: 'settle' }

export function createNavState(startId: string): PreviewNavState {
  return { history: createHistory(startId), transition: null }
}

export function previewNavReducer(
  state: PreviewNavState,
  action: PreviewNavAction,
): PreviewNavState {
  const from = currentId(state.history)
  switch (action.type) {
    case 'navigate': {
      if (action.to === from) return state
      const history = pushHistory(state.history, action.to)
      return {
        history,
        transition: startTransition(from, action.to, action.transition, 'forward', action),
      }
    }
    case 'back': {
      if (!canGoBack(state.history)) return state
      const history = backHistory(state.history)
      return {
        history,
        transition: startTransition(from, currentId(history), 'push', 'back'),
      }
    }
    case 'forward': {
      if (!canGoForward(state.history)) return state
      const history = forwardHistory(state.history)
      return {
        history,
        transition: startTransition(from, currentId(history), 'push', 'forward'),
      }
    }
    case 'jump': {
      if (action.to === from) return state
      return {
        history: pushHistory(state.history, action.to),
        transition: null,
      }
    }
    case 'settle':
      return state.transition ? { ...state, transition: null } : state
  }
}

function startTransition(
  from: string,
  to: string,
  kind: DesignTransition,
  direction: NavDirection,
  timing: { duration?: number; easing?: DesignEasing } = {},
): ActiveTransition | null {
  if (kind === 'none') return null
  const t: ActiveTransition = {
    from,
    to,
    kind,
    direction,
    duration: timing.duration ?? TRANSITION_DURATION_MS[kind],
  }
  return timing.easing ? { ...t, easing: timing.easing } : t
}

// ---- Smart Animate pairing ----

function countVtNames(tree: DesignNode, counts = new Map<string, number>()): Map<string, number> {
  const vt = tree.name ? viewTransitionName(tree.name) : null
  if (vt) counts.set(vt, (counts.get(vt) ?? 0) + 1)
  for (const child of tree.children) countVtNames(child, counts)
  return counts
}

// view-transition-names shared by both trees and unique in each: Chromium
// aborts the whole View Transition when a name appears twice on either side,
// so duplicates are left out (they get the root cross-fade). Order follows
// the origin tree.
export function vtNames(fromTree: DesignNode, toTree: DesignNode): string[] {
  const from = countVtNames(fromTree)
  const to = countVtNames(toTree)
  const names: string[] = []
  for (const [name, n] of from) {
    if (n === 1 && to.get(name) === 1) names.push(name)
  }
  return names
}
