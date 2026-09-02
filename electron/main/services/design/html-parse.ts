// HTML → DesignNode tree via parse5. Main-process only: parse5 is a
// runtime dependency and the loose HTML an agent emits needs a
// spec-compliant parser to become the same DOM the browser would build.

import { parse, parseFragment, type DefaultTreeAdapterTypes } from 'parse5'
import type { DesignNode, DesignNodeKind } from '../../../../shared/types/design'
import { newNodeId } from '../../../../shared/design/ids'
import {
  ATTR_NAME_RE,
  BLOCKED_TAGS,
  MAX_TREE_DEPTH,
  URL_ATTRS,
  isUnsafeUrl,
} from '../../../../shared/design/safety'

// Same rules, applied to trees that did not come through the parser.
export { sanitizeTree, type SanitizeResult } from './sanitize-tree'

type P5Node = DefaultTreeAdapterTypes.Node
type P5Element = DefaultTreeAdapterTypes.Element
type P5Text = DefaultTreeAdapterTypes.TextNode
type P5Parent = DefaultTreeAdapterTypes.ParentNode

export interface ParseHtmlResult {
  nodes: DesignNode[]
  globalCss: string
  fonts: string[]
  warnings: string[]
}

const FRAME_TAGS = new Set([
  'div',
  'section',
  'header',
  'footer',
  'nav',
  'main',
  'article',
  'aside',
  'ul',
  'ol',
  'form',
])

const TEXT_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'span',
  'a',
  'button',
  'li',
  'label',
  'small',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'code',
  'pre',
  'blockquote',
  'td',
  'th',
  'dt',
  'dd',
  'figcaption',
  'caption',
  'legend',
  'summary',
  'mark',
  'sub',
  'sup',
  'time',
  'abbr',
  'cite',
  'q',
])

// Landmarks read better capitalised in the layer list than as raw tags.
const LANDMARK_TAGS = new Set(['section', 'header', 'footer', 'nav', 'main'])

// Whitespace inside these is content, not formatting.
const PREFORMATTED_TAGS = new Set(['pre', 'textarea'])

// <style>/<link> feed the document; the rest of BLOCKED_TAGS is dropped.
const DROPPED_TAGS = new Set(
  [...BLOCKED_TAGS, 'template'].filter((t) => t !== 'style' && t !== 'link'),
)

// Same rule as fontsToLinks in html-render: prefix match, not substring.
const GOOGLE_FONTS_PREFIX = 'https://fonts.googleapis.com/'
const NAME_MAX_LENGTH = 24

const DOCUMENT_RE = /^\s*(<!doctype|<html)/i

function isElement(node: P5Node): node is P5Element {
  return 'tagName' in node
}

function isText(node: P5Node): node is P5Text {
  return node.nodeName === '#text'
}

// Splits `a: b; c: url("x;y")` on ';' only outside parentheses and quotes.
export function parseStyleAttr(raw: string): Record<string, string> {
  const decls: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1)
    } else if (ch === ';' && depth === 0) {
      decls.push(raw.slice(start, i))
      start = i + 1
    }
  }
  decls.push(raw.slice(start))

  const style: Record<string, string> = {}
  for (const decl of decls) {
    const colon = decl.indexOf(':')
    if (colon === -1) continue
    const rawKey = decl.slice(0, colon).trim()
    const value = decl.slice(colon + 1).trim()
    if (!rawKey || !value) continue
    // Custom properties are case-sensitive; regular properties are not.
    const key = rawKey.startsWith('--') ? rawKey : rawKey.toLowerCase()
    style[key] = value
  }
  return style
}

// Collapses whitespace runs. A run at the edges that carries a newline is
// source indentation and vanishes; a plain edge space (`Hello </span>`) is
// inline content and stays.
function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, (run: string, offset: number) => {
    const atEdge = offset === 0 || offset + run.length === raw.length
    return atEdge && run.includes('\n') ? '' : ' '
  })
}

function attrName(attr: { name: string; prefix?: string }): string {
  return attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name
}

// Layer name fallback; the renderer's LayerRow.rowLabel mirrors these rules
// for trees that predate them, so keep the two in sync.
export function deriveName(
  tag: string,
  attrs: Record<string, string>,
  text: string | undefined,
  kind: DesignNodeKind,
): string {
  if (attrs.id) return attrs.id
  if (attrs['data-name']) return attrs['data-name']
  if (kind === 'text' && text) {
    const compact = text.replace(/\s+/g, ' ').trim()
    if (compact) return compact.slice(0, NAME_MAX_LENGTH)
  }
  if (LANDMARK_TAGS.has(tag)) return tag[0].toUpperCase() + tag.slice(1)
  return tag
}

function kindFor(tag: string, parentInSvg: boolean, textOnly: boolean): DesignNodeKind {
  if (parentInSvg) return 'element'
  if (tag === 'img') return 'image'
  if (tag === 'svg') return 'svg'
  if (FRAME_TAGS.has(tag)) return 'frame'
  if (textOnly && TEXT_TAGS.has(tag)) return 'text'
  return 'element'
}

function textContent(el: P5Element): string {
  return el.childNodes.map((c) => (isText(c) ? c.value : '')).join('')
}

class Collector {
  readonly warnings: string[] = []
  readonly css: string[] = []
  readonly fonts: string[] = []

  warn(message: string): void {
    this.warnings.push(message)
  }

  // Elements that never become nodes: <style>/<link> feed the document,
  // the rest is dropped. Returns false when the element is a regular node.
  consumeSpecial(el: P5Element): boolean {
    const tag = el.tagName
    if (tag === 'style') {
      const css = textContent(el).trim()
      if (css) this.css.push(css)
      return true
    }
    if (tag === 'link') {
      const href = el.attrs.find((a) => a.name === 'href')?.value ?? ''
      if (href.startsWith(GOOGLE_FONTS_PREFIX)) {
        if (!this.fonts.includes(href)) this.fonts.push(href)
      } else {
        this.warn(`dropped <link> (only Google Fonts stylesheets are kept): ${href || '(no href)'}`)
      }
      return true
    }
    if (DROPPED_TAGS.has(tag)) {
      this.warn(`dropped <${tag}>`)
      return true
    }
    return false
  }

  attrs(el: P5Element): { attrs: Record<string, string>; style: Record<string, string> } {
    const attrs: Record<string, string> = {}
    let style: Record<string, string> = {}
    for (const attr of el.attrs) {
      const name = attrName(attr)
      const lower = name.toLowerCase()
      if (lower === 'style') {
        style = parseStyleAttr(attr.value)
        continue
      }
      if (lower.startsWith('on') || !ATTR_NAME_RE.test(name)) {
        this.warn(`dropped attribute ${name} on <${el.tagName}>`)
        continue
      }
      // Our own render marks; a pasted export must not carry them back in.
      if (lower.startsWith('data-pw-')) continue
      if (URL_ATTRS.has(lower) && isUnsafeUrl(attr.value)) {
        this.warn(`dropped unsafe ${name} on <${el.tagName}>`)
        continue
      }
      attrs[name] = attr.value
    }
    return { attrs, style }
  }

  children(
    parent: P5Parent,
    inSvg: boolean,
    preformatted: boolean,
    depth = 0,
  ): { nodes: DesignNode[]; text: string } {
    if (depth > MAX_TREE_DEPTH) throw new Error(`html nests deeper than ${MAX_TREE_DEPTH} levels`)
    const nodes: DesignNode[] = []
    // Inside SVG loose text has no <span> to live in; it rides on the parent.
    let svgText = ''
    for (const child of parent.childNodes) {
      if (isText(child)) {
        if (!child.value.trim()) continue
        const text = preformatted ? child.value : normalizeText(child.value)
        if (inSvg) {
          svgText += text
          continue
        }
        nodes.push({
          id: newNodeId(),
          tag: 'span',
          kind: 'text',
          style: {},
          attrs: {},
          text,
          children: [],
          name: deriveName('span', {}, text, 'text'),
        })
        continue
      }
      if (!isElement(child)) continue
      const node = this.element(child, inSvg, depth)
      if (node) nodes.push(node)
    }
    return { nodes, text: svgText }
  }

  element(el: P5Element, parentInSvg: boolean, depth = 0): DesignNode | null {
    if (this.consumeSpecial(el)) return null
    const tag = el.tagName
    const inSvg = parentInSvg || tag === 'svg'
    const { attrs, style } = this.attrs(el)
    const preformatted = PREFORMATTED_TAGS.has(tag)

    const textOnly = !inSvg && el.childNodes.every(isText)
    const kind = kindFor(tag, parentInSvg, textOnly)

    let text: string | undefined
    let children: DesignNode[] = []
    if (kind === 'text') {
      const raw = textContent(el)
      text = preformatted ? raw : normalizeText(raw)
    } else {
      const result = this.children(el, inSvg, preformatted, depth + 1)
      children = result.nodes
      if (result.text) text = result.text
    }

    const node: DesignNode = { id: newNodeId(), tag, kind, style, attrs, children }
    if (text !== undefined) node.text = text
    node.name = deriveName(tag, attrs, text, kind)
    return node
  }
}

function findChild(parent: P5Parent, tagName: string): P5Element | undefined {
  return parent.childNodes.find((c): c is P5Element => isElement(c) && c.tagName === tagName)
}

export function parseHtml(html: string): ParseHtmlResult {
  const collector = new Collector()
  let nodes: DesignNode[]

  if (DOCUMENT_RE.test(html)) {
    const doc = parse(html)
    const root = findChild(doc, 'html')
    const head = root && findChild(root, 'head')
    const body = root && findChild(root, 'body')
    // Head only feeds <style>/<link>/drops; whatever else it yields (title) is noise.
    if (head) collector.children(head, false, false)
    nodes = body ? collector.children(body, false, false).nodes : []
  } else {
    nodes = collector.children(parseFragment(html), false, false).nodes
  }

  return {
    nodes,
    globalCss: collector.css.join('\n'),
    fonts: collector.fonts,
    warnings: collector.warnings,
  }
}
