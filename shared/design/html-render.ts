// Árvore → HTML. TS puro (sem DOM): roda no main (protocol handler,
// export) e no renderer. O parse (HTML → árvore) fica no main com parse5.

import type { DesignArtboard, DesignDocument, DesignNode, DesignTokens } from '../types/design'

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
])

// Defesa em profundidade: o parser já recusa, mas o render é a última linha
// antes do iframe.
const BLOCKED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base'])

const TAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/
const ATTR_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:.-]*$/
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction'])

export interface RenderOptions {
  // false = export standalone: sem data-pw-*, nós hidden omitidos.
  ids: boolean
}

const EDIT: RenderOptions = { ids: true }
const EXPORT: RenderOptions = { ids: false }

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;')
}

function kebab(key: string): string {
  // Custom properties (--x) e chaves já em kebab passam intactas.
  if (key.startsWith('--') || !/[A-Z]/.test(key)) return key
  return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
}

export function styleToString(style: Record<string, string>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(style)) {
    if (value === '' || value == null) continue
    // ';' dentro do valor abriria outra declaração — vira espaço.
    parts.push(`${kebab(key)}:${value.replace(/;/g, ' ')}`)
  }
  return parts.join(';')
}

function isUnsafeUrl(value: string): boolean {
  return /^\s*(javascript|vbscript|data:text\/html)/i.test(value)
}

function renderAttrs(node: DesignNode, opts: RenderOptions): string {
  let out = ''
  for (const [name, value] of Object.entries(node.attrs)) {
    if (!ATTR_NAME_RE.test(name)) continue
    const lower = name.toLowerCase()
    if (lower === 'style' || lower.startsWith('on') || lower.startsWith('data-pw-')) continue
    if (URL_ATTRS.has(lower) && isUnsafeUrl(value)) continue
    out += ` ${name}="${escapeAttr(value)}"`
  }
  let style = styleToString(node.style)
  if (node.hidden && opts.ids) style += (style ? ';' : '') + 'display:none !important'
  if (style) out += ` style="${escapeAttr(style)}"`
  if (opts.ids) {
    out += ` data-pw-id="${escapeAttr(node.id)}"`
    if (node.hidden) out += ' data-pw-hidden=""'
    if (node.link) {
      out += ` data-pw-link="${escapeAttr(node.link.artboardId)}" data-pw-transition="${node.link.transition}"`
    }
  }
  return out
}

function renderTree(node: DesignNode, opts: RenderOptions, inSvg: boolean): string {
  if (!opts.ids && node.hidden) return ''
  const svg = inSvg || node.tag.toLowerCase() === 'svg'
  // Fora de SVG o HTML é case-insensitive; dentro, viewBox/linearGradient importam.
  const tag = svg ? node.tag : node.tag.toLowerCase()
  if (!TAG_NAME_RE.test(tag) || BLOCKED_TAGS.has(tag.toLowerCase())) return ''
  const open = `<${tag}${renderAttrs(node, opts)}>`
  if (!svg && VOID_TAGS.has(tag)) return open
  let inner = node.text != null ? escapeHtml(node.text) : ''
  for (const child of node.children) inner += renderTree(child, opts, svg)
  return `${open}${inner}</${tag}>`
}

export function renderNode(node: DesignNode, opts: RenderOptions = EDIT): string {
  return renderTree(node, opts, false)
}

// Dentro de <style>, '</' encerraria o elemento; '\/' é escape CSS válido.
function cssSafe(css: string): string {
  return css.replace(/<\//g, '<\\/')
}

export function tokensToCss(tokens: DesignTokens): string {
  const decls: string[] = []
  for (const [category, values] of Object.entries(tokens)) {
    if (!values) continue
    for (const [name, value] of Object.entries(values as Record<string, string>)) {
      decls.push(`--${category}-${name}:${value}`)
    }
  }
  return decls.length ? cssSafe(`:root{${decls.join(';')}}`) : ''
}

export function fontsToLinks(fonts: string[]): string {
  return fonts
    .filter((url) => url.startsWith('https://fonts.googleapis.com/'))
    .map((url) => `<link rel="stylesheet" href="${escapeAttr(url)}">`)
    .join('')
}

export type ArtboardRenderMode = 'edit' | 'shot' | 'preview'

export interface BuildArtboardDocumentInput {
  doc: Pick<DesignDocument, 'tokens' | 'fonts' | 'globalCss'>
  artboard: DesignArtboard
  runtimeJs: string
  nonce: string
  mode: ArtboardRenderMode
}

function artboardBackground(tree: DesignNode): string {
  return tree.style.background || tree.style.backgroundColor || '#ffffff'
}

function baseCss(artboard: DesignArtboard): string {
  return (
    'html,body{margin:0;padding:0}' +
    `body{width:${artboard.width}px;height:${artboard.height}px;overflow:hidden;` +
    `background:${artboardBackground(artboard.tree)}}`
  )
}

export function buildArtboardDocument(input: BuildArtboardDocumentInput): string {
  const { doc, artboard, runtimeJs, nonce, mode } = input
  const script =
    mode === 'shot'
      ? ''
      : `<script nonce="${escapeAttr(nonce)}">${runtimeJs.replace(/<\/script/gi, '<\\/script')}</script>`
  return (
    '<!doctype html>' +
    `<html data-pw-mode="${mode}">` +
    '<head><meta charset="utf-8">' +
    fontsToLinks(doc.fonts) +
    `<style>${tokensToCss(doc.tokens)}${cssSafe(doc.globalCss)}</style>` +
    `<style>${baseCss(artboard)}</style>` +
    '</head>' +
    `<body data-pw-artboard="${escapeAttr(artboard.id)}">` +
    renderNode(artboard.tree, EDIT) +
    script +
    '</body></html>'
  )
}

// Export: sem runtime, sem data-pw-*, nós hidden fora.
export function renderStandaloneHtml(
  doc: Pick<DesignDocument, 'tokens' | 'fonts' | 'globalCss'>,
  artboard: DesignArtboard,
): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta name="viewport" content="width=${artboard.width}">` +
    `<title>${escapeHtml(artboard.name)}</title>` +
    fontsToLinks(doc.fonts) +
    `<style>${tokensToCss(doc.tokens)}${cssSafe(doc.globalCss)}</style>` +
    `<style>${baseCss(artboard)}</style>` +
    '</head><body>' +
    renderNode(artboard.tree, EXPORT) +
    '</body></html>'
  )
}
