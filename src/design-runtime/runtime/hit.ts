// Geometry the parent asks for: hit testing, node rects and the observers
// that push rect/content-size changes without being polled.

import type { Rect } from '../../../shared/design/protocol'
import { byId, nodeId, toRect } from './dom'
import { PROTOCOL_VERSION, post } from './messaging'

let watched = new Set<string>()
let lastRectsJson = ''
let lastContentSize = ''
let rafPending = false

export function collectRects(ids: Iterable<string>): Record<string, Rect> {
  const rects: Record<string, Rect> = {}
  for (const id of ids) {
    const el = byId(id)
    if (el) rects[id] = toRect(el)
  }
  return rects
}

export function allRects(): Record<string, Rect> {
  const rects: Record<string, Rect> = {}
  for (const el of Array.from(document.querySelectorAll('[data-pw-id]'))) {
    rects[nodeId(el)] = toRect(el)
  }
  return rects
}

function reportContentSize(): void {
  const root = document.documentElement
  const w = Math.max(root.scrollWidth, document.body.scrollWidth)
  const h = Math.max(root.scrollHeight, document.body.scrollHeight)
  const key = `${w}x${h}`
  if (key === lastContentSize) return
  lastContentSize = key
  post({ v: PROTOCOL_VERSION, type: 'contentSize', w, h })
}

function flushChanges(): void {
  rafPending = false
  reportContentSize()
  if (watched.size === 0) return
  const rects = collectRects(watched)
  const json = JSON.stringify(rects)
  if (json === lastRectsJson) return
  lastRectsJson = json
  post({ v: PROTOCOL_VERSION, type: 'rectsChanged', rects })
}

export function scheduleChanges(): void {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(flushChanges)
}

// After a full re-render the parent needs the next flush even when nothing
// moved, so the dedupe keys are dropped.
export function resetChangeTracking(): void {
  lastRectsJson = ''
  lastContentSize = ''
}

export function setWatched(ids: string[]): void {
  watched = new Set(ids)
  lastRectsJson = ''
  scheduleChanges()
}

export function installObservers(): void {
  new ResizeObserver(scheduleChanges).observe(document.body)
  new MutationObserver(scheduleChanges).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  })
  window.addEventListener('resize', scheduleChanges)
  document.fonts.ready.then(scheduleChanges, () => undefined)
}

export function hitTest(
  x: number,
  y: number,
  ignore: string[],
): { id: string | null; rect: Rect | null; path: string[] } {
  const skip = new Set(ignore)
  const ignoredEls = ignore.map(byId).filter((el): el is HTMLElement => el != null)
  for (const el of document.elementsFromPoint(x, y)) {
    const target = el.closest('[data-pw-id]')
    if (!target) continue
    const id = nodeId(target)
    if (skip.has(id) || ignoredEls.some((ig) => ig.contains(target))) continue
    const path: string[] = []
    let cur: Element | null = target
    while (cur) {
      path.unshift(nodeId(cur))
      cur = cur.parentElement?.closest('[data-pw-id]') ?? null
    }
    return { id, rect: toRect(target), path }
  }
  return { id: null, rect: null, path: [] }
}

export function getComputed(id: string, props: string[]): Record<string, string> {
  const values: Record<string, string> = {}
  const el = byId(id)
  if (!el) return values
  const computed = getComputedStyle(el)
  for (const prop of props) values[prop] = computed.getPropertyValue(prop)
  return values
}
