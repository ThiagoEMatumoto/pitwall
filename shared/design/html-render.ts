// Tree → HTML. Pure TS (no DOM): runs in main (protocol handler, export)
// and in the renderer. Parsing (HTML → tree) stays in main with parse5.

import type { DesignArtboard, DesignDocument, DesignNode, DesignTokens } from '../types/design'
import { BLOCKED_TAGS, TAG_NAME_RE, isAllowedAttr, isTransition } from './safety'

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

// Defence in depth: the parser already refuses, but the render is the last
// line before the iframe. The rules (BLOCKED_TAGS, urls, attrs) live in safety.ts.

export interface RenderOptions {
  // false = standalone export: no data-pw-*, hidden nodes omitted.
  ids: boolean
}

const EDIT: RenderOptions = { ids: true }
const EXPORT: RenderOptions = { ids: false }

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;')
}

function kebab(key: string): string {
  // Custom properties (--x) and keys already in kebab pass through untouched.
  if (key.startsWith('--') || !/[A-Z]/.test(key)) return key
  return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
}

export function styleToString(style: Record<string, string>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(style)) {
    if (value === '' || value == null) continue
    // A ';' inside the value would open another declaration — becomes a space.
    parts.push(`${kebab(key)}:${value.replace(/;/g, ' ')}`)
  }
  return parts.join(';')
}

function renderAttrs(node: DesignNode, opts: RenderOptions): string {
  let out = ''
  for (const [name, value] of Object.entries(node.attrs)) {
    if (!isAllowedAttr(name, value)) continue
    out += ` ${name}="${escapeAttr(value)}"`
  }
  let style = styleToString(node.style)
  if (node.hidden && opts.ids) style += (style ? ';' : '') + 'display:none !important'
  if (style) out += ` style="${escapeAttr(style)}"`
  if (opts.ids) {
    out += ` data-pw-id="${escapeAttr(node.id)}"`
    if (node.hidden) out += ' data-pw-hidden=""'
    const link = node.link
    if (link && link.artboardId) {
      const transition = isTransition(link.transition) ? link.transition : 'none'
      out += ` data-pw-link="${escapeAttr(link.artboardId)}" data-pw-transition="${transition}"`
    }
  }
  return out
}

function renderTree(node: DesignNode, opts: RenderOptions, inSvg: boolean): string {
  if (!opts.ids && node.hidden) return ''
  const svg = inSvg || node.tag.toLowerCase() === 'svg'
  // Outside SVG, HTML is case-insensitive; inside, viewBox/linearGradient matter.
  const tag = svg ? node.tag : node.tag.toLowerCase()
  if (!TAG_NAME_RE.test(tag) || BLOCKED_TAGS.has(tag.toLowerCase())) return ''
  const open = `<${tag}${renderAttrs(node, opts)}>`
  if (!svg && VOID_TAGS.has(tag)) return open
  let inner = node.text != null ? escapeHtml(node.text) : ''
  for (const child of node.children) inner += renderTree(child, opts, svg)
  return `${open}${inner}</${tag}>`
}

// inSvg: the node is inserted under an <svg> parent (tag case preserved).
export function renderNode(node: DesignNode, opts: RenderOptions = EDIT, inSvg = false): string {
  return renderTree(node, opts, inSvg)
}

// Inside <style>, '</' would close the element; '\/' is a valid CSS escape.
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

const DEFAULT_BACKGROUND = '#ffffff'
// A value that could close the declaration/block or the <style> element is
// not a colour; the root node still paints it through its own style attr.
const UNSAFE_CSS_VALUE_RE = /[<>{};\\]|[\x00-\x1f\x7f]/

export function artboardBackground(tree: DesignNode): string {
  const value = tree.style.background || tree.style.backgroundColor || DEFAULT_BACKGROUND
  return UNSAFE_CSS_VALUE_RE.test(value) ? DEFAULT_BACKGROUND : value
}

function safeInt(value: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : 0
}

function cssPx(value: number): string {
  return `${safeInt(value)}px`
}

function baseCss(artboard: DesignArtboard): string {
  return cssSafe(
    'html,body{margin:0;padding:0}' +
      `body{width:${cssPx(artboard.width)};height:${cssPx(artboard.height)};overflow:hidden;` +
      `background:${artboardBackground(artboard.tree)}}`,
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

// Export: no runtime, no data-pw-*, hidden nodes left out.
export function renderStandaloneHtml(
  doc: Pick<DesignDocument, 'tokens' | 'fonts' | 'globalCss'>,
  artboard: DesignArtboard,
): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta name="viewport" content="width=${safeInt(artboard.width)}">` +
    `<title>${escapeHtml(artboard.name)}</title>` +
    fontsToLinks(doc.fonts) +
    `<style>${tokensToCss(doc.tokens)}${cssSafe(doc.globalCss)}</style>` +
    `<style>${baseCss(artboard)}</style>` +
    '</head><body>' +
    renderNode(artboard.tree, EXPORT) +
    '</body></html>'
  )
}
