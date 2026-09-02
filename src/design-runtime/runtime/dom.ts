// Rendering and DOM mutation inside the artboard iframe. Rendering itself is
// shared/design/html-render.ts (pure TS, bundled into the runtime), so the
// iframe paints exactly what main serves.

import type { DesignNode, DesignOp } from '../../../shared/types/design'
import type { Rect } from '../../../shared/design/protocol'
import { renderNode, tokensToCss } from '../../../shared/design/html-render'
import { isAllowedAttr, isTransition } from '../../../shared/design/safety'

export { tokensToCss }

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

export function renderBody(tree: DesignNode): void {
  // The runtime <script> lives in body too; it already ran, dropping it is fine.
  document.body.innerHTML = renderNode(tree)
  const bg = tree.style.background || tree.style.backgroundColor
  if (bg) document.body.style.background = bg
}

// ---- ops ----

export function applyOp(op: DesignOp): void {
  switch (op.type) {
    case 'insert': {
      const parent = op.parentId == null ? (rootEl() ?? document.body) : requireEl(op.parentId)
      const html = renderNode(op.node, undefined, parent.closest('svg') != null)
      insertAtIndex(parent, fragmentFor(parent, html), op.index)
      return
    }
    case 'remove': {
      for (const id of op.ids) byId(id)?.remove()
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
      } else {
        el.removeAttribute('data-pw-link')
        el.removeAttribute('data-pw-transition')
      }
      return
    }
    case 'replaceTree': {
      renderBody(op.tree)
      return
    }
    case 'setArtboard': {
      if (op.patch.width != null) document.body.style.width = `${op.patch.width}px`
      if (op.patch.height != null) document.body.style.height = `${op.patch.height}px`
      return
    }
  }
}
