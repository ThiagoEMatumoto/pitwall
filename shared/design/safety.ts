// Single source of truth for what a design tree may contain. Used by the
// parser/sanitizer (main), validateTree (everywhere), both renderers (shared
// html-render and the iframe runtime) and the MCP/IPC input limits. No DOM,
// no electron: this file is bundled into the iframe runtime too.

import type { DesignNodeLink, DesignTransition } from '../types/design'

// ---- limits ----

export const ARTBOARD_MIN_PX = 16
export const ARTBOARD_MAX_PX = 8192
// width * height * scale^2 the offscreen capture is allowed to rasterize.
export const MAX_CAPTURE_PIXELS = 40_000_000
export const MAX_HTML_BYTES = 512 * 1024
export const MAX_GLOBAL_CSS_BYTES = 512 * 1024
export const MAX_TOKEN_KEYS = 200
export const MAX_NAME_CHARS = 200
export const MAX_SUMMARY_CHARS = 200
export const MAX_TREE_DEPTH = 256
export const MAX_TREE_NODES = 20_000
export const MAX_ASSET_BYTES = 5 * 1024 * 1024
// Base64 length of MAX_ASSET_BYTES, checked before anything is decoded.
export const MAX_ASSET_BASE64_CHARS = Math.ceil(MAX_ASSET_BYTES / 3) * 4

export function clampArtboardSize(value: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return ARTBOARD_MIN_PX
  return Math.min(ARTBOARD_MAX_PX, Math.max(ARTBOARD_MIN_PX, Math.round(n)))
}

// ---- tags / attributes ----

// Never rendered, never persisted. <area> is here because a click on it
// navigates the (sandboxed) iframe like an anchor would.
export const BLOCKED_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'area',
])

export const TAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/
export const ATTR_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:.-]*$/
export const URL_ATTRS: ReadonlySet<string> = new Set([
  'href',
  'src',
  'xlink:href',
  'action',
  'formaction',
])

const SAFE_SCHEMES: ReadonlySet<string> = new Set([
  'http',
  'https',
  'mailto',
  'tel',
  'blob',
  'pitwall-design',
])
const SAFE_DATA_RE = /^data:image\/(png|jpeg|jpg|gif|webp|avif|bmp|x-icon);/i
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i

// Allowlist, evaluated the way a browser reads the value: ASCII tab/newline
// and C0 controls are stripped first so "java\nscript:" cannot slip through.
export function isUnsafeUrl(raw: string): boolean {
  const value = raw.replace(/[\x00-\x20\x7f]/g, '')
  const scheme = SCHEME_RE.exec(value)
  // Relative, fragment and protocol-relative URLs carry no scheme.
  if (!scheme) return false
  const name = scheme[1].toLowerCase()
  if (name === 'data') return !SAFE_DATA_RE.test(value)
  return !SAFE_SCHEMES.has(name)
}

// Attributes the renderers write to the DOM; style/data-pw-* travel elsewhere.
export function isAllowedAttr(name: string, value: string): boolean {
  if (!ATTR_NAME_RE.test(name)) return false
  const lower = name.toLowerCase()
  if (lower === 'style' || lower.startsWith('on') || lower.startsWith('data-pw-')) return false
  if (URL_ATTRS.has(lower) && isUnsafeUrl(value)) return false
  return true
}

// ---- links ----

export const TRANSITIONS: ReadonlySet<DesignTransition> = new Set(['none', 'push', 'fade'])

export function isTransition(value: unknown): value is DesignTransition {
  return typeof value === 'string' && TRANSITIONS.has(value as DesignTransition)
}

export function isNodeLink(value: unknown): value is DesignNodeLink {
  if (typeof value !== 'object' || value === null) return false
  const link = value as Partial<DesignNodeLink>
  return (
    typeof link.artboardId === 'string' &&
    link.artboardId.length > 0 &&
    isTransition(link.transition)
  )
}
