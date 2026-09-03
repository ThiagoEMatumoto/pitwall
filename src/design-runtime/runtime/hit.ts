// Geometry the parent asks for: hit testing, node rects and the observers
// that push rect/content-size changes without being polled.

import type { Rect } from '../../../shared/design/protocol'
import { bodySizing, byId, nodeId, toRect } from './dom'
import { PROTOCOL_VERSION, post } from './messaging'

let watched = new Set<string>()
let lastRectsJson = ''
let lastContentSize = ''
let rafPending = false
// Set by anything that can change the content (mutations, fonts, a fresh
// render); a bare viewport resize leaves it false.
let contentDirty = true
let lastViewportW = 0
let lastViewportH = 0

export function collectRects(ids: Iterable<string>): Record<string, Rect> {
  const rects: Record<string, Rect> = {}
  for (const id of ids) {
    const el = byId(id)
    if (el) rects[id] = toRect(el)
  }
  return rects
}

// Marquee clones (data-pw-clone, built by motion.ts) carry no data-pw-id,
// but a clone's subtree is still skipped explicitly: the tree never has them.
function isClone(el: Element): boolean {
  return el.closest('[data-pw-clone]') != null
}

export function allRects(): Record<string, Rect> {
  const rects: Record<string, Rect> = {}
  for (const el of Array.from(document.querySelectorAll('[data-pw-id]'))) {
    if (isClone(el)) continue
    rects[nodeId(el)] = toRect(el)
  }
  return rects
}

// Fixed reports the scroll size (what the overflow badge names). Flow reports
// the body's layout box: scrollHeight is floored at the viewport, which in
// flow is the height the parent just applied from the previous report, and
// counts transform overflow (a pending slide-up entrance), so with it the
// artboard could only ever grow.
function measureContentSize(): { w: number; h: number } {
  const root = document.documentElement
  const w = Math.max(root.scrollWidth, document.body.scrollWidth)
  if (bodySizing() === 'flow') return { w, h: document.body.offsetHeight }
  return { w, h: Math.max(root.scrollHeight, document.body.scrollHeight) }
}

function reportContentSize(): void {
  // In flow the parent resizes the iframe to the reported height; measuring
  // again on that resize would only echo it back, or feed a loop when the
  // content uses vh units. A width change is a real relayout and still reports.
  const heightOnlyResize =
    window.innerHeight !== lastViewportH && window.innerWidth === lastViewportW
  lastViewportW = window.innerWidth
  lastViewportH = window.innerHeight
  const dirty = contentDirty
  contentDirty = false
  if (heightOnlyResize && !dirty && bodySizing() === 'flow') return
  const { w, h } = measureContentSize()
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
  contentDirty = true
}

function scheduleContentChange(): void {
  contentDirty = true
  scheduleChanges()
}

export function setWatched(ids: string[]): void {
  watched = new Set(ids)
  lastRectsJson = ''
  scheduleChanges()
}

export function installObservers(): void {
  new ResizeObserver(scheduleChanges).observe(document.body)
  new MutationObserver(scheduleContentChange).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  })
  window.addEventListener('resize', scheduleChanges)
  document.fonts.ready.then(scheduleContentChange, () => undefined)
}

export function hitTest(
  x: number,
  y: number,
  ignore: string[],
): { id: string | null; rect: Rect | null; path: string[] } {
  const skip = new Set(ignore)
  const ignoredEls = ignore.map(byId).filter((el): el is HTMLElement => el != null)
  for (const el of document.elementsFromPoint(x, y)) {
    if (isClone(el)) continue
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
