// Export of one artboard: standalone HTML (assets inlined), JSX with inline
// style objects, or a PNG through the offscreen capture window.

import * as designStore from './design-store'
import * as assetStore from './asset-store'
import { captureArtboard } from './screenshot'
import { renderStandaloneHtml } from '../../../../shared/design/html-render'
import type { DesignArtboard, DesignDocument, DesignNode } from '../../../../shared/types/design'

interface Loaded {
  artboard: DesignArtboard
  doc: DesignDocument
}

function load(artboardId: string): Loaded {
  const artboard = designStore.getArtboard(artboardId)
  if (!artboard) throw new Error(`design artboard not found: ${artboardId}`)
  const docId = designStore.getArtboardDocumentId(artboardId)!
  return { artboard, doc: designStore.getDocument(docId)! }
}

const ASSET_URL_RE = new RegExp(
  `${assetStore.ASSET_URL_PREFIX.replace(/[/.]/g, '\\$&')}([A-Za-z0-9-]+)`,
  'g',
)

// The custom scheme only resolves inside Pitwall; a file opened elsewhere
// needs the bytes embedded.
export function inlineAssets(html: string): string {
  return html.replace(ASSET_URL_RE, (match, id: string) => {
    const asset = assetStore.get(id)
    if (!asset) return match
    return `data:${asset.mime};base64,${asset.bytes.toString('base64')}`
  })
}

export interface ExportTextResult {
  data: string
  width: number
  height: number
}

export function exportArtboardHtml(artboardId: string): ExportTextResult {
  const { artboard, doc } = load(artboardId)
  return {
    data: inlineAssets(renderStandaloneHtml(doc, artboard)),
    width: artboard.width,
    height: artboard.height,
  }
}

// ---- JSX ----

const JSX_ATTR_RENAMES: Record<string, string> = {
  class: 'className',
  for: 'htmlFor',
  tabindex: 'tabIndex',
  readonly: 'readOnly',
  maxlength: 'maxLength',
  autocomplete: 'autoComplete',
  'xlink:href': 'xlinkHref',
}

function camel(key: string): string {
  return key.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
}

function jsxAttrName(name: string): string {
  const lower = name.toLowerCase()
  if (JSX_ATTR_RENAMES[lower]) return JSX_ATTR_RENAMES[lower]
  // data-* and aria-* stay as-is in JSX; other hyphenated names (SVG) camelCase.
  if (lower.startsWith('data-') || lower.startsWith('aria-')) return name
  return name.includes('-') ? camel(name) : name
}

function jsxStyle(style: Record<string, string>): string {
  const entries = Object.entries(style).filter(([, v]) => v !== '' && v != null)
  if (entries.length === 0) return ''
  const body = entries
    .map(([k, v]) => {
      const key = k.startsWith('--') ? JSON.stringify(k) : camel(k)
      return `${key}: ${JSON.stringify(v)}`
    })
    .join(', ')
  return ` style={{ ${body} }}`
}

function jsxText(text: string): string {
  return /[{}<>]/.test(text) ? `{${JSON.stringify(text)}}` : text
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'source', 'track', 'wbr', 'area', 'col'])

function renderJsxNode(node: DesignNode, depth: number): string {
  if (node.hidden) return ''
  const pad = '  '.repeat(depth)
  let attrs = ''
  for (const [name, value] of Object.entries(node.attrs)) {
    if (name.toLowerCase() === 'style' || /^on/i.test(name)) continue
    attrs += ` ${jsxAttrName(name)}=${JSON.stringify(value)}`
  }
  attrs += jsxStyle(node.style)
  const tag = node.tag
  if (VOID_TAGS.has(tag.toLowerCase()) && node.children.length === 0 && !node.text) {
    return `${pad}<${tag}${attrs} />\n`
  }
  const children = node.children.map((c) => renderJsxNode(c, depth + 1)).join('')
  if (!children) {
    const text = node.text ? jsxText(node.text) : ''
    return `${pad}<${tag}${attrs}>${text}</${tag}>\n`
  }
  const text = node.text ? `${pad}  ${jsxText(node.text)}\n` : ''
  return `${pad}<${tag}${attrs}>\n${text}${children}${pad}</${tag}>\n`
}

export function renderJsx(node: DesignNode, componentName = 'Artboard'): string {
  return `export default function ${componentName}() {\n  return (\n${renderJsxNode(node, 2)}  )\n}\n`
}

function componentName(name: string): string {
  const pascal = name.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c?: string) => (c ? c.toUpperCase() : ''))
  const cleaned = pascal.replace(/^[^A-Za-z]+/, '')
  return cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : 'Artboard'
}

export function exportArtboardJsx(artboardId: string): ExportTextResult {
  const { artboard } = load(artboardId)
  return {
    data: inlineAssets(renderJsx(artboard.tree, componentName(artboard.name))),
    width: artboard.width,
    height: artboard.height,
  }
}

// ---- PNG ----

export interface ExportPngInput {
  artboardId: string
  scale?: 1 | 2
  nodeId?: string
}

export interface ExportPngResult {
  pngBase64: string
  width: number
  height: number
}

export async function exportArtboardPng(input: ExportPngInput): Promise<ExportPngResult> {
  const { artboard, doc } = load(input.artboardId)
  const shot = await captureArtboard({
    artboardId: artboard.id,
    docId: doc.id,
    width: artboard.width,
    height: artboard.height,
    scale: input.scale ?? 1,
    version: artboard.version,
    nodeId: input.nodeId,
  })
  return {
    pngBase64: shot.png.toString('base64'),
    width: shot.width,
    height: shot.height,
  }
}
