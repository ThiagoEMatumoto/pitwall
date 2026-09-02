// Pure preview logic: navigation history, sibling stepping, fit scale and
// the CSS each frame gets during a transition. PreviewMode drives it.

import type { CSSProperties } from 'react'
import type { DesignTransition } from '@shared/types/design'

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
}

export interface PreviewNavState {
  history: PreviewHistory
  transition: ActiveTransition | null
}

export const TRANSITION_DURATION_MS: Record<DesignTransition, number> = {
  none: 0,
  fade: 200,
  push: 280,
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
  | { type: 'navigate'; to: string; transition: DesignTransition }
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
        transition: startTransition(from, action.to, action.transition, 'forward'),
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
): ActiveTransition | null {
  return kind === 'none' ? null : { from, to, kind, direction }
}

// ---- frame styles ----

export type FrameRole = 'incoming' | 'outgoing'
export type FramePhase = 'start' | 'end'

// Where the frame sits at the start and at the end of the animation. The
// component renders `start` on mount, then flips to `end` on the next frame
// so the CSS transition tweens between the two.
export function frameStyle(
  t: ActiveTransition,
  role: FrameRole,
  phase: FramePhase,
  scale: number,
): CSSProperties {
  const duration = TRANSITION_DURATION_MS[t.kind]
  // No tween into the start pose: a frame that was hidden must snap there.
  const base: CSSProperties = {
    transition:
      phase === 'end'
        ? `transform ${duration}ms cubic-bezier(0.2, 0, 0, 1), opacity ${duration}ms ease`
        : 'none',
  }
  if (t.kind === 'fade') {
    const visible = role === 'incoming' ? phase === 'end' : phase === 'start'
    return { ...base, transform: `scale(${scale})`, opacity: visible ? 1 : 0 }
  }
  // push: forward slides the incoming in from the right; back reverses.
  const sign = t.direction === 'forward' ? 1 : -1
  const offset =
    role === 'incoming' ? (phase === 'start' ? 100 * sign : 0) : phase === 'start' ? 0 : -100 * sign
  // scale first so the percentage offset is in artboard px, not screen px.
  return {
    ...base,
    transform: `scale(${scale}) translateX(${offset}%)`,
    opacity: 1,
  }
}

export type ScaleMode = 'fit' | 'actual'

export interface Size {
  w: number
  h: number
}

// Fit never upscales: a 390px mobile artboard stays 390px on a 4K screen.
export function fitScale(artboard: Size, viewport: Size, mode: ScaleMode, padding = 0): number {
  if (mode === 'actual') return 1
  const availW = viewport.w - padding * 2
  const availH = viewport.h - padding * 2
  if (availW <= 0 || availH <= 0 || artboard.w <= 0 || artboard.h <= 0) return 1
  return Math.min(1, availW / artboard.w, availH / artboard.h)
}
