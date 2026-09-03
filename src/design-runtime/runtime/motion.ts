// Motion engine inside the artboard iframe: the entrance state machine
// (pending → play → done, classes from motion-css.ts), in-view resolution
// from the parent's scroll (the iframe never scrolls itself), parallax and
// the marquee clones. Pure helpers (visibleIds, marqueeKey) are exported for
// the jsdom tests.

import type { Rect } from '../../../shared/design/protocol'
import type { MotionMode } from '../../../shared/design/protocol'

export const IN_VIEW_THRESHOLD = 0.2
const PLAY = 'pw-m-play'
const DONE = 'pw-m-done'
const FROZEN_ATTR = 'data-pw-motion'

let mode: MotionMode = 'off'
// Last scroll the parent reported; null until the first `scroll` message,
// which is what turns in-view entrances on (before it they stay pending).
let scroll: { y: number; viewportH: number } | null = null
let scrollRaf = 0
const marqueeKeys = new WeakMap<Element, string>()

export function motionMode(): MotionMode {
  return mode
}

// Ids whose rect (artboard-local px) shows at least `threshold` of its
// height inside the band [y, y + viewportH]. A rect with no height counts
// once its top is inside the band.
export function visibleIds(
  rects: Record<string, Rect>,
  y: number,
  viewportH: number,
  threshold = IN_VIEW_THRESHOLD,
): string[] {
  const bottom = y + viewportH
  const out: string[] = []
  for (const [id, r] of Object.entries(rects)) {
    if (r.h <= 0) {
      if (r.y >= y && r.y <= bottom) out.push(id)
      continue
    }
    const overlap = Math.min(r.y + r.h, bottom) - Math.max(r.y, y)
    if (overlap / Math.min(r.h, viewportH || r.h) >= threshold) out.push(id)
  }
  return out
}

function entrances(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-pw-m-in]')).filter(
    (el) => !el.closest('[data-pw-clone]'),
  )
}

function isInView(el: Element): boolean {
  return el.getAttribute('data-pw-m-trigger') === 'in-view'
}

function play(el: HTMLElement): void {
  if (el.classList.contains(DONE) || el.classList.contains(PLAY)) return
  el.classList.add(PLAY)
}

function markDone(el: HTMLElement): void {
  el.classList.remove(PLAY)
  el.classList.add(DONE)
}

function reset(el: HTMLElement): void {
  el.classList.remove(PLAY, DONE)
}

// Delegated once: an entrance that ended stays in its final pose through
// .pw-m-done (animation:none), so a later style patch is not fought by the
// paused animation's fill.
let endListenerInstalled = false
function installEndListener(): void {
  if (endListenerInstalled) return
  endListenerInstalled = true
  document.addEventListener('animationend', (e) => {
    const el = e.target
    if (!(el instanceof HTMLElement) || !el.hasAttribute('data-pw-m-in')) return
    if (el.classList.contains(PLAY)) markDone(el)
  })
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

// Plays the pending in-view entrances that the last scroll uncovered.
function resolveInView(): void {
  if (!scroll) return
  const pending = entrances().filter(
    (el) => isInView(el) && !el.classList.contains(PLAY) && !el.classList.contains(DONE),
  )
  if (pending.length === 0) return
  const rects: Record<string, Rect> = {}
  pending.forEach((el, i) => {
    rects[String(i)] = rectOf(el)
  })
  for (const key of visibleIds(rects, scroll.y, scroll.viewportH)) play(pending[Number(key)])
}

function updateParallax(): void {
  if (!scroll) return
  const center = scroll.y + scroll.viewportH / 2
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-pw-m-par]'))) {
    const factor = parseFloat(el.getAttribute('data-pw-m-par') ?? '') || 0
    const current = parseFloat(el.style.getPropertyValue('--pw-par-y')) || 0
    const r = el.getBoundingClientRect()
    // The rect already carries the current translation; undo it to get the
    // element's resting centre.
    const resting = r.top - current + r.height / 2
    el.style.setProperty('--pw-par-y', String(Math.round(-(resting - center) * factor)))
  }
}

function flushScroll(): void {
  scrollRaf = 0
  if (mode !== 'on') return
  resolveInView()
  updateParallax()
}

function scheduleScrollWork(): void {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(flushScroll)
}

// Applies the current mode to one entrance element (mount, refresh, insert).
function settle(el: HTMLElement): void {
  if (mode === 'off') {
    markDone(el)
    return
  }
  reset(el)
  if (isInView(el)) return
  requestAnimationFrame(() => {
    if (mode === 'on') play(el)
  })
}

// Called after (re)rendering the body: applies `next` to the whole DOM
// (entrances settle, marquee clones, frozen attribute on <html>).
export function mount(next: MotionMode): void {
  mode = next
  const html = document.documentElement
  if (next === 'on') html.removeAttribute(FROZEN_ATTR)
  else html.setAttribute(FROZEN_ATTR, 'final')
  installEndListener()
  for (const el of entrances()) settle(el)
  syncMarquees()
  if (next === 'on') scheduleScrollWork()
}

// A repeated mode is a no-op: replaying is motionReplay's job.
export function setMotionMode(next: MotionMode): void {
  if (next !== mode) mount(next)
}

export function onScroll(y: number, viewportH: number): void {
  scroll = { y, viewportH }
  scheduleScrollWork()
}

// Replays the entrances of `ids` (or all) from their initial pose, in-view
// ones included: a replay is an explicit request to see the animation.
export function replay(ids?: string[]): void {
  if (mode !== 'on') return
  const targets = ids
    ? ids.flatMap((id) => {
        const el = document.querySelector<HTMLElement>(`[data-pw-id="${CSS.escape(id)}"]`)
        if (!el) return []
        return el.hasAttribute('data-pw-m-in') ? [el, ...entrances(el)] : entrances(el)
      })
    : entrances()
  for (const el of targets) reset(el)
  // Force a style flush so removing and re-adding the class restarts the animation.
  void document.body.offsetWidth
  requestAnimationFrame(() => {
    for (const el of targets) if (mode === 'on') el.classList.add(PLAY)
  })
}

// After a setMotion op (or an insert) the element and its children carry new
// data-pw-m-* attributes: give them the state the mode dictates.
export function refresh(root: HTMLElement): void {
  const els = root.hasAttribute('data-pw-m-in') ? [root, ...entrances(root)] : entrances(root)
  for (const el of els) settle(el)
  syncMarquees()
  if (mode === 'on') scheduleScrollWork()
}

// ---- marquee ----

// Identity of a marquee's originals: when it changes (text edit, style
// patch, child inserted) the clones are rebuilt.
export function marqueeKey(el: Element): string {
  return Array.from(el.children)
    .filter((c) => !c.hasAttribute('data-pw-clone'))
    .map((c) => c.outerHTML)
    .join('')
}

function stripIds(root: Element): void {
  root.removeAttribute('data-pw-id')
  for (const el of Array.from(root.querySelectorAll('[data-pw-id]')))
    el.removeAttribute('data-pw-id')
}

function buildClones(el: HTMLElement): void {
  for (const c of Array.from(el.children)) if (c.hasAttribute('data-pw-clone')) c.remove()
  const originals = Array.from(el.children)
  let width = 0
  for (const c of originals) width += c.getBoundingClientRect().width
  el.style.setProperty('--pw-marquee-w', `${Math.round(width)}px`)
  for (const c of originals) {
    const clone = c.cloneNode(true) as Element
    stripIds(clone)
    clone.setAttribute('data-pw-clone', '')
    clone.setAttribute('aria-hidden', 'true')
    el.appendChild(clone)
  }
}

function dropClones(el: HTMLElement): void {
  for (const c of Array.from(el.children)) if (c.hasAttribute('data-pw-clone')) c.remove()
  el.style.removeProperty('--pw-marquee-w')
  marqueeKeys.delete(el)
}

// Clones exist only while the runtime animates (mode on); in edit the list
// shows its originals alone so rects and hit-tests match the tree.
export function syncMarquees(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-pw-clone]'))) {
    const host = el.parentElement
    if (!host || mode !== 'on' || host.getAttribute('data-pw-m-loop') !== 'marquee') {
      el.remove()
      if (host) dropClones(host)
    }
  }
  if (mode !== 'on') return
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>('[data-pw-m-loop="marquee"]'),
  )) {
    const key = marqueeKey(el)
    if (marqueeKeys.get(el) === key) continue
    marqueeKeys.set(el, key)
    buildClones(el)
  }
}
