// Tree → HTML. Pure TS (no DOM): runs in main (protocol handler, export)
// and in the renderer. Parsing (HTML → tree) stays in main with parse5.

import type {
  ArtboardSizing,
  DesignArtboard,
  DesignDocument,
  DesignNode,
  DesignTokens,
} from '../types/design'
import {
  BLOCKED_TAGS,
  MIN_FLOW_HEIGHT_PX,
  TAG_NAME_RE,
  isAllowedAttr,
  isSizing,
  isTransition,
} from './safety'
import {
  childMotionContext,
  isEasing,
  motionAttrs,
  treeHasMotion,
  type MotionContext,
} from './motion'
import { MOTION_CSS, MOTION_EXPORT_JS } from './motion-css'

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

// Motion attributes/variables are derived, never part of node.style or
// node.attrs, and come AFTER the user's declarations (the hidden pattern):
// the user's style survives a style patch untouched and the variables win.
export function renderAttrs(
  node: DesignNode,
  opts: RenderOptions,
  motionCtx: MotionContext = {},
): string {
  let out = ''
  for (const [name, value] of Object.entries(node.attrs)) {
    if (!isAllowedAttr(name, value)) continue
    out += ` ${name}="${escapeAttr(value)}"`
  }
  const motion = motionAttrs(node, motionCtx)
  let style = styleToString(node.style)
  if (node.hidden && opts.ids) style += (style ? ';' : '') + 'display:none !important'
  const vars = styleToString(motion.vars)
  if (vars) style += (style ? ';' : '') + vars
  if (style) out += ` style="${escapeAttr(style)}"`
  for (const [name, value] of Object.entries(motion.attrs)) {
    out += ` ${name}="${escapeAttr(value)}"`
  }
  if (opts.ids) {
    out += ` data-pw-id="${escapeAttr(node.id)}"`
    if (node.hidden) out += ' data-pw-hidden=""'
    const link = node.link
    if (link && link.artboardId) {
      const transition = isTransition(link.transition) ? link.transition : 'none'
      out += ` data-pw-link="${escapeAttr(link.artboardId)}" data-pw-transition="${transition}"`
      if (typeof link.duration === 'number' && Number.isFinite(link.duration)) {
        out += ` data-pw-t-dur="${Math.round(link.duration)}"`
      }
      if (isEasing(link.easing)) out += ` data-pw-t-ease="${link.easing}"`
    }
  }
  return out
}

function renderTree(
  node: DesignNode,
  opts: RenderOptions,
  inSvg: boolean,
  motionCtx: MotionContext,
): string {
  if (!opts.ids && node.hidden) return ''
  const svg = inSvg || node.tag.toLowerCase() === 'svg'
  // Outside SVG, HTML is case-insensitive; inside, viewBox/linearGradient matter.
  const tag = svg ? node.tag : node.tag.toLowerCase()
  if (!TAG_NAME_RE.test(tag) || BLOCKED_TAGS.has(tag.toLowerCase())) return ''
  const open = `<${tag}${renderAttrs(node, opts, motionCtx)}>`
  if (!svg && VOID_TAGS.has(tag)) return open
  let inner = node.text != null ? escapeHtml(node.text) : ''
  node.children.forEach((child, index) => {
    inner += renderTree(child, opts, svg, childMotionContext(node, index))
  })
  return `${open}${inner}</${tag}>`
}

// inSvg: the node is inserted under an <svg> parent (tag case preserved).
// motionCtx: what childMotionContext(parent, index) gives for a node rendered
// on its own (the runtime's insert); omitted = no inherited stagger.
export function renderNode(
  node: DesignNode,
  opts: RenderOptions = EDIT,
  inSvg = false,
  motionCtx: MotionContext = {},
): string {
  return renderTree(node, opts, inSvg, motionCtx)
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

// Pose the document freezes in until a runtime lifts html[data-pw-motion]:
// final = after every entrance (the default: shots, exports, the editor);
// initial = before them (a "before" shot).
export type ArtboardMotionPose = 'final' | 'initial'

export const MOTION_POSES: ReadonlySet<ArtboardMotionPose> = new Set(['final', 'initial'])

export function isMotionPose(value: unknown): value is ArtboardMotionPose {
  return typeof value === 'string' && MOTION_POSES.has(value as ArtboardMotionPose)
}

export interface BuildArtboardDocumentInput {
  doc: Pick<DesignDocument, 'tokens' | 'fonts' | 'globalCss'>
  artboard: DesignArtboard
  runtimeJs: string
  nonce: string
  mode: ArtboardRenderMode
  // Omitted = 'final'.
  motion?: ArtboardMotionPose
}

const MOTION_STYLE = `<style id="pw-motion">${MOTION_CSS}</style>`

function scriptSafe(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script')
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

// Rows written before sizing existed, or a stray value, render as fixed.
export function artboardSizing(artboard: Pick<DesignArtboard, 'sizing'>): ArtboardSizing {
  return isSizing(artboard.sizing) ? artboard.sizing : 'fixed'
}

// flow: the body is as tall as its content and never clips, so the iframe
// (sized by the parent from `contentSize`) shows everything. The root node's
// default height:100% resolves to auto under a body with height:auto, hence
// the min-height on the body.
function bodySize(artboard: DesignArtboard): string {
  if (artboardSizing(artboard) === 'flow') {
    return `width:${cssPx(artboard.width)};min-height:${MIN_FLOW_HEIGHT_PX}px;height:auto;overflow:visible;`
  }
  return `width:${cssPx(artboard.width)};height:${cssPx(artboard.height)};overflow:hidden;`
}

function baseCss(artboard: DesignArtboard): string {
  return cssSafe(
    'html,body{margin:0;padding:0}' +
      `body{${bodySize(artboard)}background:${artboardBackground(artboard.tree)}}`,
  )
}

export function buildArtboardDocument(input: BuildArtboardDocumentInput): string {
  const { doc, artboard, runtimeJs, nonce, mode } = input
  const motion = input.motion ?? 'final'
  const script =
    mode === 'shot' ? '' : `<script nonce="${escapeAttr(nonce)}">${scriptSafe(runtimeJs)}</script>`
  return (
    '<!doctype html>' +
    `<html data-pw-mode="${mode}" data-pw-sizing="${artboardSizing(artboard)}" data-pw-motion="${motion}">` +
    '<head><meta charset="utf-8">' +
    fontsToLinks(doc.fonts) +
    `<style>${tokensToCss(doc.tokens)}${cssSafe(doc.globalCss)}</style>` +
    `<style>${baseCss(artboard)}</style>` +
    MOTION_STYLE +
    '</head>' +
    `<body data-pw-artboard="${escapeAttr(artboard.id)}">` +
    renderNode(artboard.tree, EDIT) +
    script +
    '</body></html>'
  )
}

// Export: no runtime, no data-pw-id/link, hidden nodes left out. A tree with
// motion keeps its data-pw-m-* attributes, the sheet and a small script; the
// document ships frozen in the final pose so it reads without JS.
export function renderStandaloneHtml(
  doc: Pick<DesignDocument, 'tokens' | 'fonts' | 'globalCss'>,
  artboard: DesignArtboard,
): string {
  const motion = treeHasMotion(artboard.tree)
  return (
    `<!doctype html><html${motion ? ' data-pw-motion="final"' : ''}><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=${safeInt(artboard.width)}">` +
    `<title>${escapeHtml(artboard.name)}</title>` +
    fontsToLinks(doc.fonts) +
    `<style>${tokensToCss(doc.tokens)}${cssSafe(doc.globalCss)}</style>` +
    `<style>${baseCss(artboard)}</style>` +
    (motion ? MOTION_STYLE : '') +
    '</head><body>' +
    renderNode(artboard.tree, EXPORT) +
    (motion ? `<script>${scriptSafe(MOTION_EXPORT_JS)}</script>` : '') +
    '</body></html>'
  )
}
