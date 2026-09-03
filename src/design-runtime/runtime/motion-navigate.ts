// Preview player: swaps the body to another artboard's tree through a View
// Transition. Smart Animate pairs nodes by name (view-transition-name:
// pw-<slug>) the way Figma does; push/fade animate the root; without
// document.startViewTransition (jsdom, old engines) the swap is instant.

import type { DesignNode } from '../../../shared/types/design'
import type { NavigateMessage } from '../../../shared/design/protocol'
import { EASING_CSS, viewTransitionName } from '../../../shared/design/motion'
import { byId, renderBody, type BodySize } from './dom'
import { mount } from './motion'

const DEFAULT_VT_DURATION_MS = 300

// Slug → node id for every node whose slug is unique in `tree`. Duplicated
// names are dropped altogether: Chromium aborts a View Transition when two
// elements share a name, so an ambiguous pair is worth less than none.
function uniqueSlugs(tree: DesignNode): Map<string, string> {
  const counts = new Map<string, number>()
  const ids = new Map<string, string>()
  const walk = (node: DesignNode): void => {
    const slug = node.name ? viewTransitionName(node.name) : null
    if (slug) {
      counts.set(slug, (counts.get(slug) ?? 0) + 1)
      ids.set(slug, node.id)
    }
    node.children.forEach(walk)
  }
  walk(tree)
  for (const [slug, n] of counts) if (n > 1) ids.delete(slug)
  return ids
}

export interface ViewTransitionPairs {
  // node id (in `from`) → view-transition-name
  from: Map<string, string>
  // node id (in `to`) → the same name
  to: Map<string, string>
}

// Pairs are the names unique on BOTH sides; nodes without a pair cross-fade
// with the root.
export function viewTransitionPairs(from: DesignNode, to: DesignNode): ViewTransitionPairs {
  const a = uniqueSlugs(from)
  const b = uniqueSlugs(to)
  const pairs: ViewTransitionPairs = { from: new Map(), to: new Map() }
  for (const [slug, fromId] of a) {
    const toId = b.get(slug)
    if (toId === undefined) continue
    pairs.from.set(fromId, slug)
    pairs.to.set(toId, slug)
  }
  return pairs
}

function applyNames(names: Map<string, string>): void {
  for (const [id, name] of names) {
    const el = byId(id)
    if (el) el.style.setProperty('view-transition-name', name)
  }
}

function clearNames(names: Map<string, string>): void {
  for (const id of names.keys()) byId(id)?.style.removeProperty('view-transition-name')
}

function sizeOf(msg: NavigateMessage): BodySize {
  return { width: msg.width, height: msg.height, sizing: msg.sizing }
}

// Resolves once the new tree is in the DOM and the transition (if any) has
// settled. Entrances of the new screen start right after.
export async function navigate(msg: NavigateMessage, current: DesignNode | null): Promise<void> {
  const html = document.documentElement
  const size = sizeOf(msg)
  const pairs =
    msg.transition === 'smart' && current
      ? viewTransitionPairs(current, msg.tree)
      : { from: new Map<string, string>(), to: new Map<string, string>() }
  const swap = (): void => {
    renderBody(msg.tree, size)
    applyNames(pairs.to)
  }
  // jsdom and old engines have no startViewTransition: instant swap.
  if (typeof document.startViewTransition !== 'function' || msg.transition === 'none') {
    swap()
    clearNames(pairs.to)
    mount('on')
    return
  }
  html.setAttribute('data-pw-vt', msg.transition)
  html.setAttribute('data-pw-vt-dir', msg.direction)
  html.style.setProperty('--pw-vt-dur', `${Math.round(msg.duration ?? DEFAULT_VT_DURATION_MS)}ms`)
  html.style.setProperty('--pw-vt-ease', msg.easing ? EASING_CSS[msg.easing] : 'ease-out')
  applyNames(pairs.from)
  try {
    await document.startViewTransition(swap).finished
  } catch {
    // Skipped or aborted transition: the DOM was still updated.
  } finally {
    clearNames(pairs.to)
    html.removeAttribute('data-pw-vt')
    html.removeAttribute('data-pw-vt-dir')
    html.style.removeProperty('--pw-vt-dur')
    html.style.removeProperty('--pw-vt-ease')
  }
  mount('on')
}
