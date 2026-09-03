// Rendering and DOM mutation inside the artboard iframe. Rendering itself is
// shared/design/html-render.ts (pure TS, bundled into the runtime), so the
// iframe paints exactly what main serves. The runtime keeps its own copy of
// the tree (applyOp from shared/design/ops.ts): motion attributes derive
// from the model (a parent's stagger reaches its children), not from the DOM.

import type { ArtboardSizing, DesignNode, DesignOp } from '../../../shared/types/design'
import type { Rect } from '../../../shared/design/protocol'
import { renderNode, tokensToCss } from '../../../shared/design/html-render'
import { MIN_FLOW_HEIGHT_PX, isAllowedAttr, isTransition } from '../../../shared/design/safety'
import { applyOp as applyTreeOp, findNode } from '../../../shared/design/ops'
import { childMotionContext, motionAttrs, type MotionContext } from '../../../shared/design/motion'
import { refresh as refreshMotion } from './motion'

export { tokensToCss }

export interface BodySize {
  width: number
  height: number
  sizing: ArtboardSizing
}

let tree: DesignNode | null = null
// What the body was last told; null fields fall back to the document's own
// base CSS (init carries no size, only sizing).
let body: {
  width: number | null
  height: number | null
  sizing: ArtboardSizing
} = {
  width: null,
  height: null,
  sizing: 'fixed',
}

export function currentTree(): DesignNode | null {
  return tree
}

function kebab(key: string): string {
  if (key.startsWith('--') || !/[A-Z]/.test(key)) return key
  return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
}

// ---- DOM helpers ----

export function byId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-pw-id="${CSS.escape(id)}"]`)
}

export function requireEl(id: string): HTMLElement {
  const el = byId(id)
  if (!el) throw new Error(`node not found: ${id}`)
  return el
}

export function toRect(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

export function nodeId(el: Element): string {
  return el.getAttribute('data-pw-id') ?? ''
}

// Parses in the parent's namespace so `<path>` inserted into an `<svg>`
// becomes an SVG element rather than an HTMLUnknownElement.
function fragmentFor(parent: Element, html: string): DocumentFragment {
  const range = document.createRange()
  range.selectNodeContents(parent)
  return range.createContextualFragment(html)
}

function insertAtIndex(parent: Element, nodes: Node, index: number): void {
  const ref = parent.children[index] ?? null
  parent.insertBefore(nodes, ref)
}

function rootEl(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(':scope > [data-pw-id]')
}

function directTextNodes(el: Element): Text[] {
  const out: Text[] = []
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) out.push(child as Text)
  }
  return out
}

export function setNodeText(el: Element, text: string): void {
  for (const t of directTextNodes(el)) t.remove()
  if (text !== '') el.insertBefore(document.createTextNode(text), el.firstChild)
}

export function readNodeText(el: Element): string {
  if (el.children.length === 0) return el.textContent ?? ''
  return directTextNodes(el)
    .map((t) => t.data)
    .join('')
}

export function tokensStyleEl(): HTMLStyleElement {
  let el = document.getElementById('pw-tokens') as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = 'pw-tokens'
    document.head.prepend(el)
  }
  return el
}

export function ensureFonts(fonts: string[]): void {
  for (const url of fonts) {
    if (!url.startsWith('https://fonts.googleapis.com/')) continue
    const present = Array.from(document.head.querySelectorAll('link[rel="stylesheet"]')).some(
      (link) => link.getAttribute('href') === url,
    )
    if (present) continue
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = url
    document.head.appendChild(link)
  }
}

// ---- body size ----

// flow: the body is as tall as its content and never clips (the parent sizes
// the iframe from contentSize); fixed: the artboard's own height, clipped.
export function applyBodySize(patch: Partial<BodySize>): void {
  body = { ...body, ...patch }
  const style = document.body.style
  if (body.width != null) style.width = `${body.width}px`
  if (body.sizing === 'flow') {
    style.height = 'auto'
    style.minHeight = `${MIN_FLOW_HEIGHT_PX}px`
    style.overflow = 'visible'
    return
  }
  style.removeProperty('min-height')
  style.overflow = 'hidden'
  if (body.height != null) style.height = `${body.height}px`
}

export function bodySizing(): ArtboardSizing {
  return body.sizing
}

export function renderBody(next: DesignNode, size?: BodySize): void {
  tree = next
  // The runtime <script> lives in body too; it already ran, dropping it is fine.
  document.body.innerHTML = renderNode(next)
  const bg = next.style.background || next.style.backgroundColor
  document.body.style.background = bg || ''
  if (size) applyBodySize(size)
}

// ---- motion attributes on a live element ----

function clearMotionAttrs(el: HTMLElement): void {
  for (const name of Array.from(el.getAttributeNames())) {
    if (name.startsWith('data-pw-m-')) el.removeAttribute(name)
  }
  for (const prop of Array.from(el.style)) {
    if (prop.startsWith('--pw-')) el.style.removeProperty(prop)
  }
  el.classList.remove('pw-m-play', 'pw-m-done')
}

function writeMotionAttrs(el: HTMLElement, node: DesignNode, ctx: MotionContext): void {
  clearMotionAttrs(el)
  const { attrs, vars } = motionAttrs(node, ctx)
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value)
  for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value)
}

// Re-derives the node's attributes and its children's (a stagger on the
// parent is what the children animate with).
function applyMotion(id: string): void {
  if (!tree) return
  const found = findNode(tree, id)
  if (!found) return
  const el = requireEl(id)
  const parentCtx = found.parent
    ? childMotionContext(found.parent, found.parent.children.indexOf(found.node))
    : {}
  writeMotionAttrs(el, found.node, parentCtx)
  found.node.children.forEach((child, index) => {
    const childEl = byId(child.id)
    if (childEl) writeMotionAttrs(childEl, child, childMotionContext(found.node, index))
  })
  refreshMotion(el)
}

// A staggered list numbers its children (--pw-i): any change to the
// sibling order re-derives the whole list.
function restagger(parentId: string | null): boolean {
  if (!tree) return false
  const parent = parentId == null ? tree : findNode(tree, parentId)?.node
  if (!parent?.motion?.entrance?.stagger) return false
  applyMotion(parent.id)
  return true
}

function parentIdOf(id: string): string | null {
  return tree ? (findNode(tree, id)?.parent?.id ?? null) : null
}

// ---- ops ----

export function applyOp(op: DesignOp): void {
  // Source parents are read BEFORE the op: after it the nodes are gone or elsewhere.
  const priorParents =
    op.type === 'remove' || op.type === 'move' ? new Set(op.ids.map(parentIdOf)) : null
  if (tree && op.type !== 'setArtboard') tree = applyTreeOp(tree, op).tree
  switch (op.type) {
    case 'insert': {
      const parent = op.parentId == null ? (rootEl() ?? document.body) : requireEl(op.parentId)
      const parentNode = tree && op.parentId != null ? findNode(tree, op.parentId)?.node : tree
      const ctx = parentNode ? childMotionContext(parentNode, op.index) : {}
      const html = renderNode(op.node, undefined, parent.closest('svg') != null, ctx)
      insertAtIndex(parent, fragmentFor(parent, html), op.index)
      if (restagger(op.parentId)) return
      const el = byId(op.node.id)
      if (el) refreshMotion(el)
      return
    }
    case 'remove': {
      for (const id of op.ids) byId(id)?.remove()
      for (const parentId of priorParents ?? []) restagger(parentId)
      return
    }
    case 'move': {
      const parent = requireEl(op.parentId)
      const els = op.ids.map(requireEl)
      for (const el of els) {
        if (el === parent || el.contains(parent))
          throw new Error(`cannot move node into itself: ${nodeId(el)}`)
      }
      // Same semantics as shared/design/ops.ts: detach first, then the index
      // addresses the remaining siblings.
      for (const el of els) el.remove()
      const frag = document.createDocumentFragment()
      for (const el of els) frag.appendChild(el)
      insertAtIndex(parent, frag, op.index)
      for (const parentId of priorParents ?? []) if (parentId !== op.parentId) restagger(parentId)
      restagger(op.parentId)
      return
    }
    case 'setStyle': {
      const el = requireEl(op.id)
      for (const [key, value] of Object.entries(op.patch)) {
        const prop = kebab(key)
        if (value == null || value === '') el.style.removeProperty(prop)
        else el.style.setProperty(prop, value)
      }
      return
    }
    case 'setAttrs': {
      const el = requireEl(op.id)
      for (const [name, value] of Object.entries(op.patch)) {
        if (value == null) {
          if (isAllowedAttr(name, '')) el.removeAttribute(name)
        } else if (isAllowedAttr(name, value)) {
          el.setAttribute(name, value)
        }
      }
      return
    }
    case 'setText': {
      setNodeText(requireEl(op.id), op.text)
      return
    }
    case 'rename':
      // Layer names are not part of the DOM.
      return
    case 'setLink': {
      const el = requireEl(op.id)
      if (op.link && op.link.artboardId) {
        el.setAttribute('data-pw-link', op.link.artboardId)
        el.setAttribute(
          'data-pw-transition',
          isTransition(op.link.transition) ? op.link.transition : 'none',
        )
        if (op.link.duration != null)
          el.setAttribute('data-pw-t-dur', String(Math.round(op.link.duration)))
        else el.removeAttribute('data-pw-t-dur')
        if (op.link.easing) el.setAttribute('data-pw-t-ease', op.link.easing)
        else el.removeAttribute('data-pw-t-ease')
      } else {
        for (const name of [
          'data-pw-link',
          'data-pw-transition',
          'data-pw-t-dur',
          'data-pw-t-ease',
        ])
          el.removeAttribute(name)
      }
      return
    }
    case 'setMotion': {
      applyMotion(op.id)
      return
    }
    case 'replaceTree': {
      renderBody(op.tree)
      return
    }
    case 'setArtboard': {
      const patch: Partial<BodySize> = {}
      if (op.patch.width != null) patch.width = op.patch.width
      if (op.patch.sizing != null) patch.sizing = op.patch.sizing
      // In flow the height is measured, never imposed: a stale height coming
      // back from the store must not clip the content.
      const sizing = op.patch.sizing ?? body.sizing
      if (op.patch.height != null && sizing === 'fixed') patch.height = op.patch.height
      applyBodySize(patch)
      return
    }
  }
}
