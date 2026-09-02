// Runtime that lives inside the artboard iframe (sandbox, opaque origin).
// Self-contained on purpose: only `import type` is allowed here because the
// file is bundled as a dependency-free IIFE (vite.runtime.config.ts) and
// inlined into the document with a CSP nonce. The HTML rendering below is a
// copy of shared/design/html-render.ts renderNode — keep them in sync.

import type {
  DesignNode,
  DesignOp,
  DesignTokens,
  DesignTransition,
} from '../../shared/types/design'
import type {
  ParentToRuntimeMessage,
  Rect,
  RuntimeToParentMessage,
} from '../../shared/design/protocol'

interface RuntimeConfig {
  artboardId: string
  mode: 'edit' | 'preview' | 'shot'
  token: string
}

declare global {
  interface Window {
    __PITWALL_DESIGN__?: Partial<RuntimeConfig>
  }
}

const PROTOCOL_VERSION = 1

// ---- config ----

function readConfig(): RuntimeConfig {
  const injected = window.__PITWALL_DESIGN__ ?? {}
  let urlMode = ''
  let urlToken = ''
  try {
    const params = new URL(location.href).searchParams
    urlMode = params.get('mode') ?? ''
    urlToken = params.get('t') ?? ''
  } catch {
    // location may be unparseable in odd embeds; fall back to the DOM.
  }
  const domMode = document.documentElement.getAttribute('data-pw-mode') ?? ''
  const mode = injected.mode || urlMode || domMode
  return {
    artboardId: injected.artboardId ?? document.body.getAttribute('data-pw-artboard') ?? '',
    mode: mode === 'preview' || mode === 'shot' ? mode : 'edit',
    token: injected.token ?? urlToken,
  }
}

const config = readConfig()
let mode: 'edit' | 'preview' = config.mode === 'preview' ? 'preview' : 'edit'

// ---- messaging ----

function post(msg: RuntimeToParentMessage): void {
  window.parent.postMessage(msg, '*')
}

// ---- mini renderer (mirror of shared/design/html-render.ts) ----

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])
const BLOCKED_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
])
const TAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/
const ATTR_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:.-]*$/
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction'])

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;')
}

function kebab(key: string): string {
  if (key.startsWith('--') || !/[A-Z]/.test(key)) return key
  return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
}

function styleToString(style: Record<string, string>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(style)) {
    if (value === '' || value == null) continue
    parts.push(`${kebab(key)}:${value.replace(/;/g, ' ')}`)
  }
  return parts.join(';')
}

function isUnsafeUrl(value: string): boolean {
  return /^\s*(javascript|vbscript|data:text\/html)/i.test(value)
}

function isAllowedAttr(name: string, value: string): boolean {
  if (!ATTR_NAME_RE.test(name)) return false
  const lower = name.toLowerCase()
  if (lower === 'style' || lower.startsWith('on') || lower.startsWith('data-pw-')) return false
  if (URL_ATTRS.has(lower) && isUnsafeUrl(value)) return false
  return true
}

function renderAttrs(node: DesignNode): string {
  let out = ''
  for (const [name, value] of Object.entries(node.attrs)) {
    if (!isAllowedAttr(name, value)) continue
    out += ` ${name}="${escapeAttr(value)}"`
  }
  let style = styleToString(node.style)
  if (node.hidden) style += (style ? ';' : '') + 'display:none !important'
  if (style) out += ` style="${escapeAttr(style)}"`
  out += ` data-pw-id="${escapeAttr(node.id)}"`
  if (node.hidden) out += ' data-pw-hidden=""'
  if (node.link) {
    out += ` data-pw-link="${escapeAttr(node.link.artboardId)}" data-pw-transition="${node.link.transition}"`
  }
  return out
}

function renderTree(node: DesignNode, inSvg: boolean): string {
  const svg = inSvg || node.tag.toLowerCase() === 'svg'
  const tag = svg ? node.tag : node.tag.toLowerCase()
  if (!TAG_NAME_RE.test(tag) || BLOCKED_TAGS.has(tag.toLowerCase())) return ''
  const open = `<${tag}${renderAttrs(node)}>`
  if (!svg && VOID_TAGS.has(tag)) return open
  let inner = node.text != null ? escapeHtml(node.text) : ''
  for (const child of node.children) inner += renderTree(child, svg)
  return `${open}${inner}</${tag}>`
}

function tokensToCss(tokens: DesignTokens): string {
  const decls: string[] = []
  for (const [category, values] of Object.entries(tokens)) {
    if (!values) continue
    for (const [name, value] of Object.entries(values as Record<string, string>)) {
      decls.push(`--${category}-${name}:${value}`)
    }
  }
  return decls.length ? `:root{${decls.join(';')}}`.replace(/<\//g, '<\\/') : ''
}

// ---- DOM helpers ----

function byId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-pw-id="${CSS.escape(id)}"]`)
}

function requireEl(id: string): HTMLElement {
  const el = byId(id)
  if (!el) throw new Error(`node not found: ${id}`)
  return el
}

function toRect(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

function nodeId(el: Element): string {
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

function setNodeText(el: Element, text: string): void {
  for (const t of directTextNodes(el)) t.remove()
  if (text !== '') el.insertBefore(document.createTextNode(text), el.firstChild)
}

function readNodeText(el: Element): string {
  if (el.children.length === 0) return el.textContent ?? ''
  return directTextNodes(el)
    .map((t) => t.data)
    .join('')
}

function tokensStyleEl(): HTMLStyleElement {
  let el = document.getElementById('pw-tokens') as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = 'pw-tokens'
    document.head.prepend(el)
  }
  return el
}

function ensureFonts(fonts: string[]): void {
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

function renderBody(tree: DesignNode): void {
  // The runtime <script> lives in body too; it already ran, dropping it is fine.
  document.body.innerHTML = renderTree(tree, false)
  const bg = tree.style.background || tree.style.backgroundColor
  if (bg) document.body.style.background = bg
}

// ---- ops ----

function applyOp(op: DesignOp): void {
  switch (op.type) {
    case 'insert': {
      const parent = op.parentId == null ? (rootEl() ?? document.body) : requireEl(op.parentId)
      insertAtIndex(
        parent,
        fragmentFor(parent, renderTree(op.node, parent.closest('svg') != null)),
        op.index,
      )
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

// ---- rects / observers ----

let watched = new Set<string>()
let lastRectsJson = ''
let lastContentSize = ''
let rafPending = false

function collectRects(ids: Iterable<string>): Record<string, Rect> {
  const rects: Record<string, Rect> = {}
  for (const id of ids) {
    const el = byId(id)
    if (el) rects[id] = toRect(el)
  }
  return rects
}

function allRects(): Record<string, Rect> {
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

function scheduleChanges(): void {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(flushChanges)
}

function installObservers(): void {
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

// ---- hit test ----

function hitTest(
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

// ---- text editing ----

interface TextEditSession {
  id: string
  el: HTMLElement
  original: string
  onKeyDown: (e: KeyboardEvent) => void
  onBlur: () => void
}

let textEdit: TextEditSession | null = null

function endTextEdit(reason: 'commit' | 'escape' | 'blur'): void {
  const session = textEdit
  if (!session) return
  textEdit = null
  const { el, id, original } = session
  el.removeEventListener('keydown', session.onKeyDown)
  el.removeEventListener('blur', session.onBlur)
  const text = reason === 'escape' ? original : readNodeText(el)
  el.contentEditable = 'false'
  el.removeAttribute('contenteditable')
  // Normalise whatever contenteditable produced back to the model shape.
  setNodeText(el, text)
  el.blur()
  post({ v: PROTOCOL_VERSION, type: 'textEditEnd', id, text, reason })
}

function startTextEdit(id: string): void {
  if (textEdit) endTextEdit('blur')
  const el = requireEl(id)
  const session: TextEditSession = {
    id,
    el,
    original: readNodeText(el),
    onKeyDown: (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        endTextEdit('escape')
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        endTextEdit('commit')
      }
    },
    onBlur: () => endTextEdit('blur'),
  }
  textEdit = session
  el.contentEditable = 'plaintext-only'
  el.addEventListener('keydown', session.onKeyDown)
  el.addEventListener('blur', session.onBlur)
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

// ---- interaction guards ----

function installInteractionGuards(): void {
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target as Element | null
      if (!target) return
      if (mode === 'preview') {
        const link = target.closest<HTMLElement>('[data-pw-link]')
        if (link) {
          e.preventDefault()
          const transition = (link.getAttribute('data-pw-transition') || 'none') as DesignTransition
          post({
            v: PROTOCOL_VERSION,
            type: 'navigate',
            toArtboardId: link.getAttribute('data-pw-link') ?? '',
            transition,
          })
          return
        }
        // Real anchors would navigate the iframe away from the artboard.
        if (target.closest('a[href]')) e.preventDefault()
        return
      }
      if (target.closest('a, button, input, select, textarea, label, form')) e.preventDefault()
    },
    true,
  )
  document.addEventListener('submit', (e) => e.preventDefault(), true)
  document.addEventListener(
    'keydown',
    (e) => {
      const mod = e.metaKey || e.ctrlKey
      // Focus lands inside the iframe after a click or a text edit; the keys
      // the parent owns are forwarded. In preview those are the overlay's
      // navigation keys, unless the prototype itself is taking typed input.
      const forward =
        mode === 'edit'
          ? e.key === 'Escape' || (mod && e.key === 'Enter')
          : PREVIEW_FORWARDED_KEYS.has(e.key) && !isTypingTarget(e.target)
      if (!forward) return
      post({
        v: PROTOCOL_VERSION,
        type: 'key',
        key: e.key,
        mod,
        shift: e.shiftKey,
      })
    },
    true,
  )
}

const PREVIEW_FORWARDED_KEYS = new Set(['Escape', 'Backspace', 'ArrowLeft', 'ArrowRight'])

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

// ---- message dispatch ----

let initialised = false

function handleInit(msg: Extract<ParentToRuntimeMessage, { type: 'init' }>): void {
  if (config.token && msg.token !== config.token) return
  mode = msg.mode
  document.documentElement.setAttribute('data-pw-mode', mode)
  tokensStyleEl().textContent = tokensToCss(msg.tokens)
  ensureFonts(msg.fonts)
  renderBody(msg.tree)
  lastRectsJson = ''
  lastContentSize = ''
  if (!initialised) {
    initialised = true
    installObservers()
    installInteractionGuards()
  }
  post({ v: PROTOCOL_VERSION, type: 'rendered' })
  scheduleChanges()
}

function handleMessage(msg: ParentToRuntimeMessage): void {
  switch (msg.type) {
    case 'init':
      handleInit(msg)
      return
    case 'ops': {
      if (!initialised) {
        post({
          v: PROTOCOL_VERSION,
          type: 'opResult',
          reqId: msg.reqId,
          ok: false,
          error: 'not initialised',
        })
        return
      }
      try {
        for (const op of msg.ops) applyOp(op)
        post({
          v: PROTOCOL_VERSION,
          type: 'opResult',
          reqId: msg.reqId,
          ok: true,
        })
      } catch (err) {
        post({
          v: PROTOCOL_VERSION,
          type: 'opResult',
          reqId: msg.reqId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      scheduleChanges()
      return
    }
    case 'setTokens':
      tokensStyleEl().textContent = tokensToCss(msg.tokens)
      scheduleChanges()
      return
    case 'hitTest': {
      const hit = hitTest(msg.x, msg.y, msg.ignore ?? [])
      post({ v: PROTOCOL_VERSION, type: 'hit', reqId: msg.reqId, ...hit })
      return
    }
    case 'getRects':
      post({
        v: PROTOCOL_VERSION,
        type: 'rects',
        reqId: msg.reqId,
        rects: msg.ids ? collectRects(msg.ids) : allRects(),
      })
      return
    case 'watch':
      watched = new Set(msg.ids)
      lastRectsJson = ''
      scheduleChanges()
      return
    case 'textEditStart':
      try {
        startTextEdit(msg.id)
      } catch {
        post({
          v: PROTOCOL_VERSION,
          type: 'textEditEnd',
          id: msg.id,
          text: '',
          reason: 'escape',
        })
      }
      return
    case 'getComputed': {
      const values: Record<string, string> = {}
      const el = byId(msg.id)
      if (el) {
        const computed = getComputedStyle(el)
        for (const prop of msg.props) values[prop] = computed.getPropertyValue(prop)
      }
      post({ v: PROTOCOL_VERSION, type: 'computed', reqId: msg.reqId, values })
      return
    }
  }
}

function isIncoming(data: unknown): data is ParentToRuntimeMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { v?: unknown }).v === PROTOCOL_VERSION &&
    typeof (data as { type?: unknown }).type === 'string'
  )
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) return
  if (!isIncoming(event.data)) return
  handleMessage(event.data)
})

post({
  v: PROTOCOL_VERSION,
  type: 'ready',
  artboardId: config.artboardId,
  protocol: PROTOCOL_VERSION,
})
